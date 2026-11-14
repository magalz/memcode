import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppState, Project, WorkItem } from "../src/shared";
import { canMoveTask, isActive, validateDependencies } from "../src/domain";
import { LocalStore, exists, git, now, within } from "./local";
import { MemtraceEngine } from "./memtrace";
import { WorkerManager } from "./workers";
import { PreviewManager } from "./preview";
import { localURL } from "./urls";
import { planRoute } from "./router";
import { discoverHarnesses } from "./catalog";
import { registerPlanning, attachDogfoodProject } from "./planning";
import { ensureTaskEpic } from "./epic-workspace";

app.setName("MemCode");
if (process.env.MEMCODE_DATA_DIR)
  app.setPath("userData", resolve(process.env.MEMCODE_DATA_DIR));
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
let window: BrowserWindow | null = null;
let closing = false;
const identifier = z.string().min(1).max(200);
const nonempty = z.string().trim().min(1);
const stage = z.enum(["planned", "working", "review", "done"]);
const harness = z.enum(["codex", "claude", "cursor"]);
const kind = z.enum(["feature", "fix", "refactor", "research", "test"]);
const priority = z.enum(["high", "medium", "low"]);

async function start(): Promise<void> {
  Menu.setApplicationMenu(null);
  const store = new LocalStore(app.getPath("userData"));
  await store.load();
  if (!app.isPackaged && (await exists(join(app.getAppPath(), ".git"))))
    attachDogfoodProject(store.state, app.getAppPath());
  const engine = new MemtraceEngine(() => store.state.settings.memtracePath);
  const state = () => store.state;
  const changed = async () => {
    await store.save();
    if (window && !window.isDestroyed())
      window.webContents.send("workspace:state", store.state);
  };
  const workers = new WorkerManager(state, changed, engine, store.dir);
  window = new BrowserWindow({
    width: 1512,
    height: 1000,
    minWidth: 1080,
    minHeight: 740,
    frame: false,
    title: "MemCode",
    backgroundColor: "#f3f7f4",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  const win = window;
  const preview = new PreviewManager(win, state, store.dir, changed);
  const selectedFolders = new Set<string>();
  const task = (id: string) => {
    const item = store.state.tasks.find((t) => t.id === id);
    if (!item) throw new Error("Work item not found.");
    return item;
  };
  const project = (id: string) => {
    const item = store.state.projects.find((p) => p.id === id);
    if (!item) throw new Error("Project not found.");
    return item;
  };
  const register = (
    name: string,
    schema: z.ZodType,
    handler: (value: any) => unknown,
  ) =>
    ipcMain.handle(name, (event, input) => {
      if (
        event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame
      )
        throw new Error(
          "This action is only available in the MemCode workspace.",
        );
      return handler(schema.parse(input));
    });
  const analyze = async (id: string) => {
    const item = project(id);
    if (item.example || !item.path)
      throw new Error("Choose a local project folder first.");
    if (["connecting", "indexing"].includes(item.analysis)) return;
    item.analysis = "connecting";
    item.analysisNote = "Connecting to local Memtrace…";
    await changed();
    try {
      item.repoId = await engine.analyze(item, (note) => {
        item.analysis = "indexing";
        item.analysisNote = note;
        void changed();
      });
      item.analysis = "ready";
      item.analysisNote = "Project code context is connected.";
      await changed();
    } catch (error) {
      item.analysis = "error";
      item.analysisNote = (error as Error).message;
      await changed();
      throw error;
    }
  };

  register("workspace:load", z.undefined(), async () => ({
    state: store.state,
    runtime: await store.runtime(),
  }));
  register("project:select-folder", z.undefined(), async () => {
    preview.hide();
    const result = await dialog.showOpenDialog(win, {
      title: "Choose a local project folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled) return null;
    const path = await realpath(result.filePaths[0]);
    selectedFolders.add(path);
    return path;
  });
  register("project:select", identifier, async (id) => {
    project(id);
    store.state.activeProjectId = id;
    await changed();
  });
  register(
    "project:create",
    z.object({
      mode: z.enum(["existing", "new"]),
      parent: nonempty,
      name: nonempty.max(80),
      description: z.string().max(10000),
    }),
    async (input) => {
      const parent = await realpath(input.parent);
      if (!selectedFolders.has(parent))
        throw new Error("Choose the folder with the project picker first.");
      if (!(await stat(parent)).isDirectory())
        throw new Error("Choose a project folder.");
      let path = parent;
      if (input.mode === "new") {
        const slug = input.name
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "-")
          .replace(/^-|-$/g, "");
        if (!slug)
          throw new Error("Use a project name containing letters or numbers.");
        path = join(parent, slug);
        if (!within(parent, path) || (await exists(path)))
          throw new Error(
            "A folder with that name already exists. Choose a different name.",
          );
        await mkdir(path);
        await git(path, ["init", "--initial-branch=main"]);
        await writeFile(
          join(path, "README.md"),
          `# ${input.name}\n\n${input.description || "A new project, started in MemCode."}\n`,
        );
        await writeFile(
          join(path, ".gitignore"),
          ".memcode/\n.memdb/\n.memtrace/\nnode_modules/\n.env\n",
        );
        await git(path, ["add", "--", "README.md", ".gitignore"]);
        await git(path, [
          "-c",
          "user.name=MemCode",
          "-c",
          "user.email=local@memcode.invalid",
          "commit",
          "-m",
          "Start project from MemCode brief",
        ]);
      }
      const existing = store.state.projects.find(
        (p) =>
          p.path &&
          resolve(p.path).toLowerCase() === resolve(path).toLowerCase(),
      );
      if (existing) {
        store.state.activeProjectId = existing.id;
        await changed();
        return existing;
      }
      let branch = "main";
      try {
        branch = (await git(path, ["branch", "--show-current"])) || "main";
      } catch {
        /* A folder can be analyzed before Git is set up. */
      }
      const item: Project = {
        id: randomUUID(),
        name: input.name,
        description: input.description,
        path,
        branch,
        analysis: "idle",
        createdAt: now(),
      };
      store.state.projects.push(item);
      store.state.activeProjectId = item.id;
      if (input.mode === "new") {
        const brief: WorkItem = {
          id: randomUUID(),
          identifier: "MC-001",
          projectId: item.id,
          title: "Define the first working version",
          description:
            input.description ||
            "Describe who this project is for and the smallest useful version to build.",
          stage: "planned",
          priority: "high",
          harness: store.state.settings.defaultHarness,
          assignment: "auto",
          category: "Planning",
          checklist: [
            {
              id: randomUUID(),
              text: "Clarify the purpose and intended user",
              done: !!input.description,
            },
            {
              id: randomUUID(),
              text: "Define the first useful outcome",
              done: false,
            },
            {
              id: randomUUID(),
              text: "Build a focused first iteration",
              done: false,
            },
          ],
          messages: [
            {
              id: randomUUID(),
              role: "user",
              text: input.description || "Let’s define this new project.",
              at: now(),
            },
          ],
          run: { state: "idle" },
          createdAt: now(),
          updatedAt: now(),
        };
        ensureTaskEpic(store.state, brief);
        store.state.tasks.push(brief);
      }
      await changed();
      void analyze(item.id).catch(() => {});
      return item;
    },
  );
  register("project:analyze", identifier, analyze);
  registerPlanning(register, state, project, changed);
  register(
    "task:create",
    z.object({
      projectId: identifier,
      title: nonempty.max(160),
      description: z.string().max(20000),
      priority,
      harness,
      assignment: z.enum(["auto", "manual"]).optional(),
      epicId: identifier.nullable().optional(),
      kind: kind.optional(),
    }),
    async (input) => {
      const parent = project(input.projectId);
      if (
        input.epicId &&
        !store.state.epics.some(
          (epic) => epic.id === input.epicId && epic.projectId === parent.id,
        )
      )
        throw new Error("Choose an epic from this project.");
      const count =
        store.state.tasks
          .filter((t) => t.projectId === parent.id)
          .reduce(
            (max, t) =>
              Math.max(max, Number(t.identifier.split("-").at(-1)) || 0),
            0,
          ) + 1;
      const item: WorkItem = {
        ...input,
        assignment: input.assignment ?? "auto",
        kind: input.kind ?? "feature",
        id: randomUUID(),
        identifier: `MC-${String(count).padStart(3, "0")}`,
        category: "Work",
        stage: "planned",
        checklist: [
          {
            id: randomUUID(),
            text: "Understand the relevant source and requirements",
            done: false,
          },
          { id: randomUUID(), text: "Implement a focused change", done: false },
          {
            id: randomUUID(),
            text: "Review the result and checks",
            done: false,
          },
        ],
        messages: [
          {
            id: randomUUID(),
            role: "user",
            text: input.description || input.title,
            at: now(),
          },
        ],
        run: { state: "idle" },
        createdAt: now(),
        updatedAt: now(),
        ...(parent.example ? { example: true } : {}),
      };
      ensureTaskEpic(store.state, item);
      store.state.tasks.push(item);
      await changed();
      return item;
    },
  );
  register(
    "task:update",
    z.object({
      id: identifier,
      patch: z
        .object({
          title: nonempty.max(160).optional(),
          description: z.string().max(20000).optional(),
          stage: stage.optional(),
          priority: priority.optional(),
          harness: harness.optional(),
          assignment: z.enum(["auto", "manual"]).optional(),
          modelOverride: z.string().max(200).nullable().optional(),
          epicId: identifier.nullable().optional(),
          dependsOn: z.array(identifier).max(100).optional(),
          scope: z.array(z.string().max(1000)).max(20).optional(),
          kind: kind.optional(),
          checklist: z
            .array(
              z.object({
                id: identifier,
                text: nonempty.max(1000),
                done: z.boolean(),
              }),
            )
            .max(100)
            .optional(),
        })
        .strict(),
    }),
    async ({ id, patch }) => {
      const item = task(id);
      if (
        patch.stage === "done" &&
        store.state.fleetConflicts.some(
          (conflict) =>
            conflict.status === "open" &&
            conflict.projectId === item.projectId &&
            (conflict.epicId === item.epicId ||
              conflict.taskIds.includes(item.id)),
        )
      )
        throw new Error(
          "Resolve the Fleet decision before accepting this story.",
        );
      if (patch.stage && !canMoveTask(item, patch.stage))
        throw new Error(
          "Stop or finish the active worker before moving this work item.",
        );
      if (patch.harness && isActive(item))
        throw new Error("Stop the worker before changing its harness.");
      if (
        isActive(item) &&
        (patch.assignment ||
          patch.modelOverride !== undefined ||
          patch.scope ||
          patch.kind)
      )
        throw new Error(
          "The active worker keeps its current route and scope. Stop it before changing the assignment.",
        );
      if (patch.dependsOn)
        validateDependencies(store.state.tasks, item, patch.dependsOn);
      if (
        patch.epicId &&
        !store.state.epics.some(
          (e) => e.id === patch.epicId && e.projectId === item.projectId,
        )
      )
        throw new Error("Choose an epic from this project.");
      if (
        patch.assignment ||
        patch.harness ||
        patch.modelOverride !== undefined ||
        patch.scope ||
        patch.kind
      )
        item.route = undefined;
      Object.assign(item, patch, { updatedAt: now() });
      await changed();
    },
  );
  register(
    "task:message",
    z.object({ id: identifier, text: nonempty.max(20000) }),
    async ({ id, text }) => {
      const item = task(id);
      item.messages.push({ id: randomUUID(), role: "user", text, at: now() });
      item.updatedAt = now();
      await changed();
    },
  );
  register("task:qualify", identifier, async (id) => {
    const item = task(id);
    if (isActive(item))
      throw new Error(
        "This worker is active. Its current route stays bound to the running attempt.",
      );
    if (item.example)
      throw new Error(
        "Example context is not measured. Connect a project to gather real evidence.",
      );
    item.evidence = await engine.qualify(project(item.projectId), item);
    item.route = planRoute(
      item,
      item.evidence,
      await discoverHarnesses(),
      store.state.settings,
    );
    item.harness = item.route.harness;
    await changed();
  });
  register("worker:start", identifier, async (id) => {
    const item = task(id);
    await workers.start(item, project(item.projectId));
  });
  register("worker:stop", identifier, (id) => workers.stop(id));
  register("fleet:refresh", identifier, (id) =>
    workers.fleet.refresh(project(id)),
  );
  register(
    "fleet:resolve",
    z.object({
      id: identifier,
      resolution: nonempty.max(10000),
      winnerTaskId: identifier.optional(),
    }),
    async ({ id, resolution, winnerTaskId }) => {
      const conflict = store.state.fleetConflicts.find(
        (item) => item.id === id,
      );
      if (!conflict) throw new Error("Fleet decision not found.");
      await workers.pause(conflict.taskIds);
      await workers.fleet.resolve(id, resolution, winnerTaskId);
    },
  );
  register("worker:open-folder", identifier, async (id) => {
    const item = task(id);
    const workspace = item.run.workspace ?? item.run.worktree;
    if (!workspace)
      throw new Error("This story has no active epic workspace yet.");
    const result = await shell.openPath(workspace);
    if (result) throw new Error(result);
  });
  register(
    "settings:save",
    z
      .object({
        memtracePath: z.string().max(1000),
        speechEndpoint: z.string().max(1000),
        defaultHarness: harness,
        model: z.string().max(200),
        localModel: z.boolean(),
        maxWorkers: z.number().int().min(1).max(8),
      })
      .strict(),
    async (settings) => {
      localURL(settings.speechEndpoint);
      if (settings.localModel && !settings.model.trim())
        throw new Error(
          "Enter the name of an installed Ollama model for local-model mode.",
        );
      if (store.state.tasks.some((t) => isActive(t) && !t.example))
        throw new Error(
          "Stop active workers before changing runtime settings.",
        );
      await engine.close();
      store.state.settings = settings;
      await changed();
      return store.runtime();
    },
  );
  register(
    "preview:show",
    z.object({
      taskId: identifier,
      url: z.string().max(2000).optional(),
      artifactId: identifier.optional(),
      bounds: z.object({
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        width: z.number().int().min(1),
        height: z.number().int().min(1),
      }),
    }),
    (input) => preview.show(input),
  );
  register("preview:hide", z.undefined(), () => preview.hide());
  register(
    "preview:action",
    z.enum(["back", "forward", "reload", "capture"]),
    (value) => preview.action(value),
  );
  register("artifact:read", identifier, async (id) => {
    const artifact = store.state.artifacts.find((a) => a.id === id);
    if (!artifact || artifact.kind !== "text")
      throw new Error("Text artifact not found.");
    const path = await realpath(artifact.path);
    const item = task(artifact.taskId);
    const roots = [
      join(store.dir, "examples"),
      ...(item.run.workspace
        ? [
            join(
              item.run.workspace,
              ".memcode",
              "workers",
              item.id,
              "artifacts",
            ),
          ]
        : []),
      ...(item.run.worktree
        ? [join(item.run.worktree, ".memcode", "artifacts")]
        : []),
    ];
    if (!roots.some((root) => within(root, path)))
      throw new Error("Artifact path is outside the output folders.");
    if ((await stat(path)).size > 1_000_000)
      throw new Error("This text artifact is too large for inline preview.");
    return readFile(path, "utf8");
  });
  register(
    "speech:transcribe",
    z.custom<ArrayBuffer>(
      (value) =>
        value instanceof ArrayBuffer &&
        value.byteLength >= 44 &&
        value.byteLength < 20_000_000,
    ),
    async (wav) => {
      const bytes = Buffer.from(wav);
      if (
        bytes.toString("ascii", 0, 4) !== "RIFF" ||
        bytes.toString("ascii", 8, 12) !== "WAVE"
      )
        throw new Error("Dictation requires a WAV recording.");
      const endpoint = localURL(store.state.settings.speechEndpoint);
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(wav)], { type: "audio/wav" }),
        "dictation.wav",
      );
      form.append("response_format", "json");
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(120_000),
          redirect: "error",
        });
      } catch {
        throw new Error(
          "The local speech server could not be reached. Start whisper.cpp or update Local dictation in Settings.",
        );
      }
      if (!response.ok)
        throw new Error(
          `Local transcription failed (${response.status}). Check the Whisper server.`,
        );
      const result = (await response.json()) as { text?: string };
      if (!result.text?.trim())
        throw new Error("No speech was detected. Try a shorter recording.");
      return result.text.trim();
    },
  );
  register(
    "window:action",
    z.enum(["minimize", "maximize", "close"]),
    (value) => {
      if (value === "minimize") win.minimize();
      if (value === "maximize") {
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
      }
      if (value === "close") win.close();
    },
  );
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });
  win.webContents.session.setPermissionRequestHandler(
    (contents, permission, callback, details) =>
      callback(
        contents === win.webContents &&
          permission === "media" &&
          "mediaTypes" in details &&
          !!details.mediaTypes?.length &&
          details.mediaTypes.every((type) => type === "audio"),
      ),
  );
  win.webContents.session.setPermissionCheckHandler(
    (contents, permission) =>
      contents === win.webContents && permission === "media",
  );
  win.once("ready-to-show", () => win.show());
  win.on("close", (event) => {
    if (closing) return;
    event.preventDefault();
    void (async () => {
      await workers.close();
      preview.close();
      await engine.close();
      await store.save();
      closing = true;
      win.close();
    })().catch((error) => {
      dialog.showErrorBox("MemCode could not finish closing", error.message);
    });
  });
  await createExampleArtifacts(store);
  const dev = process.env.MEMCODE_DEV_URL;
  if (dev) {
    if (new URL(dev).origin !== "http://127.0.0.1:5197")
      throw new Error(
        "The development renderer must run on the configured local port.",
      );
    await win.loadURL(dev);
  } else await win.loadFile(join(__dirname, "..", "dist", "index.html"));
}

async function createExampleArtifacts(store: LocalStore): Promise<void> {
  if (store.state.artifacts.some((a) => a.id === "example-preview")) return;
  const root = join(store.dir, "examples");
  await mkdir(root, { recursive: true });
  const html = join(root, "workspace-preview.html");
  await writeFile(
    html,
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:#f3f7f4;color:#12271b;padding:40px}.eyebrow{font-size:9px;letter-spacing:2px;color:#528d76}.hero{border-radius:20px;background:radial-gradient(ellipse at 100% 0,#174b37,transparent 70%),#0b1d13;padding:44px 35px;color:#ecf9ef;margin-top:22px}h1{font-size:clamp(28px,6vw,56px);font-weight:450;line-height:1.05;letter-spacing:-2px;margin:0 0 20px}h1 span{color:#8db6a0}p{font-size:12px;line-height:1.9;color:#8fae99;max-width:390px}.pill{display:inline-block;margin-top:20px;border-radius:30px;background:#bde9d0;color:#163d27;font-size:10px;padding:12px 18px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:20px}.card{padding:22px 18px;background:#fff;border:1px solid #e1eadf;border-radius:12px}.card small{font-size:9px;color:#8da18d}.card h2{font-size:18px;font-weight:500;letter-spacing:-.5px}.card p{font-size:10px;color:#889d86}.caption{font-size:8px;letter-spacing:1px;color:#91a38d;margin-top:22px}</style></head><body><div class="eyebrow">MEMCODE · EXAMPLE ARTIFACT</div><section class="hero"><h1>Ideas, made real.<br><span>Work, kept in focus.</span></h1><p>A local workspace for the conversations, context and coordinated work that turn an idea into working software.</p><span class="pill">Your code. Your fleet. Your workspace. ↗</span></section><div class="grid"><div class="card"><small>01 / UNDERSTAND</small><h2>Context first.</h2><p>Ground the work in source relationships and a clear brief.</p></div><div class="card"><small>02 / COORDINATE</small><h2>Move together.</h2><p>Give every worker a focused place in the bigger picture.</p></div><div class="card"><small>03 / REVIEW</small><h2>See the result.</h2><p>Keep changes, previews and artifacts close to the work.</p></div></div><div class="caption">ILLUSTRATIVE DESIGN OUTPUT · NO AGENT WAS RUN TO PRODUCE THIS EXAMPLE</div></body></html>`,
  );
  store.state.artifacts.push({
    id: "example-preview",
    name: "workspace-preview.html",
    kind: "html",
    path: html,
    taskId: "example-06",
    projectId: "example",
    createdAt: now(),
    source: "Example output",
  });
  const text = join(root, "workspace-notes.md");
  await writeFile(
    text,
    "# MemCode workspace notes\n\nThis is an example artifact.\n\n- MemCode is an independent Electron app.\n- Memtrace supplies code intelligence and Fleet coordination.\n- Story workers share an epic branch with Memtrace Fleet coordination.\n- Conversations, runbooks, changes and artifacts stay together.\n- A finished worker produces a review candidate.\n",
  );
  store.state.artifacts.push({
    id: "example-notes",
    name: "workspace-notes.md",
    kind: "text",
    path: text,
    taskId: "example-08",
    projectId: "example",
    createdAt: now(),
    source: "Example output",
  });
  await store.save();
}

if (lock) {
  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      dialog.showErrorBox("MemCode could not start", error.message);
      app.quit();
    });
}
app.on("window-all-closed", () => app.quit());
