import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve, isAbsolute, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppState, Project, WorkItem } from "../src/shared";
import { isActive } from "../src/domain";
import { LocalStore, exists, git, now, within } from "./local";
import { MemtraceEngine } from "./memtrace";
import { WorkerManager } from "./workers";
import { PreviewManager, artifactRoots } from "./preview";
import { localURL } from "./urls";
import { planRoute } from "./router";
import { discoverHarnesses } from "./catalog";
import { registerPlanning, attachDogfoodProject } from "./planning";
import { registerPlanningControls } from "./planning-controls";
import { ensureTaskEpic } from "./epic-workspace";
import { createExampleArtifacts } from "./examples";
import { taskPlanningShape, applyTaskPatch } from "./task-planning";
import { registerIntelligence } from "./intelligence";
import type { NativeHost, Emit } from "./host";
import { contextAssistantDefaults } from "../src/context-settings";
import { browserRequestSchema } from "../src/browser";
import { AgentBrowserManager } from "./browser/manager";
import { TerminalManager } from "./terminals";
import { terminalRequestSchema } from "../src/terminal";
import { readWorkerChanges, WorkerChangeJournal } from "./changes";
import { resolveFile } from "./files";
import { registerReview } from "./review";
import {
  formatReviewMessage,
  reviewReferenceSchema,
  type ReviewReference,
} from "../src/review";

const identifier = z.string().min(1).max(200),
  nonempty = z.string().trim().min(1),
  stage = z.enum(["planned", "working", "review", "done"]),
  harness = z.enum(["codex", "claude", "cursor"]),
  kind = z.enum(["feature", "fix", "refactor", "research", "test"]),
  priority = z.enum(["high", "medium", "low"]);
const taskPatch = z
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
    ...taskPlanningShape,
  })
  .strict();
type Handler = { schema: z.ZodType; handle: (input: any) => unknown };

export async function createRuntime(
  dataDir: string,
  appPath: string,
  host: NativeHost,
  emit: Emit,
) {
  const store = new LocalStore(dataDir);
  await store.load();
  if (await exists(join(appPath, ".git")))
    attachDogfoodProject(store.state, appPath);
  const engine = new MemtraceEngine(() => store.state.settings.memtracePath),
    state = () => store.state;
  const changed = async () => {
    await store.save();
    emit("workspace:state", store.state);
  };
  const browsers = new AgentBrowserManager(state, store.dir, changed, 16, host);
  const terminals = new TerminalManager(state, host);
  const workers = new WorkerManager(
      state,
      changed,
      engine,
      store.dir,
      undefined,
      undefined,
      browsers,
      terminals,
    ),
    preview = new PreviewManager(
      host,
      state,
      store.dir,
      changed,
      emit,
      appPath,
    );
  const selectedFolders = new Set<string>(),
    handlers = new Map<string, Handler>();
  const task = (id: string) => {
    const item = store.state.tasks.find((task) => task.id === id);
    if (!item) throw new Error("Story not found.");
    return item;
  };
  const project = (id: string) => {
    const item = store.state.projects.find((project) => project.id === id);
    if (!item) throw new Error("Project not found.");
    return item;
  };
  const register = (
    name: string,
    schema: z.ZodType,
    handle: (input: any) => unknown,
  ) => {
    handlers.set(name, { schema, handle });
  };
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
  // The platform-independent routes retained from the original desktop runtime.
  register("workspace:load", z.undefined(), async () => ({
    state: store.state,
    runtime: await store.runtime(),
  }));
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
  register(
    "task:message",
    z
      .object({
        id: identifier,
        text: nonempty.max(20000),
        references: z.array(reviewReferenceSchema).max(8).optional(),
      })
      .strict(),
    async ({ id, text, references }) => {
      const item = task(id);
      if (references?.some((ref: ReviewReference) => ref.taskId !== id))
        throw Error("Comments must belong to this work item.");
      const body = references?.length
        ? formatReviewMessage(text, references)
        : text;
      if (body.length > 48000)
        throw Error(
          "This follow-up is too long. Use fewer or shorter selections.",
        );
      item.messages.push({
        id: randomUUID(),
        role: "user",
        text: body,
        at: now(),
        ...(references?.length ? { references } : {}),
      });
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
        contextAssistant: z
          .object({
            enabled: z.boolean(),
            provider: z.enum(["onnx", "openai-compatible"]),
            packageDirectory: z.string().max(2000),
            baseUrl: z.string().max(2000),
            model: z.string().max(500),
          })
          .strict()
          .optional(),
      })
      .strict(),
    async (settings) => {
      localURL(settings.speechEndpoint);
      if (settings.contextAssistant?.enabled) {
        const helper = settings.contextAssistant;
        if (!helper.model.trim())
          throw new Error("Choose an installed model for context assistance.");
        if (helper.provider === "openai-compatible") localURL(helper.baseUrl);
        else {
          if (helper.model !== contextAssistantDefaults.model)
            throw new Error(
              "The cached ONNX pilot uses Qwen2.5-Coder-0.5B-Instruct. Select that model or use a local model server.",
            );
          if (!isAbsolute(helper.packageDirectory))
            throw new Error(
              "Choose the absolute installed Transformers package directory for local context assistance.",
            );
          let manifest: { name?: string };
          try {
            manifest = JSON.parse(
              await readFile(
                join(helper.packageDirectory, "package.json"),
                "utf8",
              ),
            );
          } catch {
            throw new Error(
              "The Transformers package directory could not be read.",
            );
          }
          if (manifest.name !== "@huggingface/transformers")
            throw new Error(
              "Choose the @huggingface/transformers package directory with your cached model.",
            );
        }
      }
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
  register("artifact:read", identifier, async (id) => {
    const artifact = store.state.artifacts.find((a) => a.id === id);
    if (!artifact || artifact.kind === "html")
      throw new Error("Inline artifact not found.");
    const path = await realpath(artifact.path);
    const item = task(artifact.taskId);
    const roots = artifactRoots(store.dir, item);
    if (!roots.some((root) => within(root, path)))
      throw new Error("Artifact path is outside the output folders.");
    if (
      (await stat(path)).size >
      (artifact.kind === "image" ? 25_000_000 : 1_000_000)
    )
      throw new Error("This artifact is too large for inline preview.");
    if (artifact.kind === "image") {
      const mime: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
      };
      const type = mime[extname(path).toLowerCase()];
      if (!type) throw Error("Unsupported inline image format.");
      return `data:${type};base64,${(await readFile(path)).toString("base64")}`;
    }
    return readFile(path, "utf8");
  });
  register(
    "file:resolve",
    z
      .object({
        taskId: identifier,
        href: z.string().min(1).max(6000),
        basePath: z.string().max(4000).optional(),
      })
      .strict(),
    ({ taskId, href, basePath }) =>
      resolveFile(store.state, store.dir, taskId, href, basePath),
  );

  registerPlanning(register, state, project, changed);
  registerReview(register, state, changed, () => preview.publishComments());
  registerPlanningControls(register, state, project, changed);
  registerIntelligence(register, state, project, changed, engine);
  register("project:select-folder", z.undefined(), async () => {
    await preview.hide();
    const selected = await host.call<string | null>("select_folder", {});
    if (!selected) return null;
    const path = await realpath(selected);
    selectedFolders.add(path);
    return path;
  });
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
      ...taskPlanningShape,
    }),
    async (input) => {
      const parent = project(input.projectId);
      if (
        input.cycleId &&
        !state().cycles.some(
          (cycle) =>
            cycle.id === input.cycleId &&
            cycle.projectId === parent.id &&
            cycle.state !== "completed",
        )
      )
        throw new Error("Choose an unfinished cycle in this project.");
      const count =
        state()
          .tasks.filter((task) => task.projectId === parent.id)
          .reduce(
            (max, task) =>
              Math.max(max, Number(task.identifier.split("-").at(-1)) || 0),
            0,
          ) + 1;
      const item: WorkItem = {
        id: randomUUID(),
        identifier: `MC-${String(count).padStart(3, "0")}`,
        projectId: parent.id,
        title: input.title,
        description: input.description,
        priority: input.priority,
        harness: input.harness,
        assignment: input.assignment ?? "auto",
        kind: input.kind ?? "feature",
        epicId: input.epicId,
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
      const { projectId, ...fields } = input;
      applyTaskPatch(state(), item, taskPatch.parse(fields));
      ensureTaskEpic(state(), item);
      state().tasks.push(item);
      await changed();
      return item;
    },
  );
  register(
    "task:update",
    z.object({ id: identifier, patch: taskPatch }),
    async ({ id, patch }) => {
      applyTaskPatch(state(), task(id), patch);
      await changed();
    },
  );
  register(
    "task:bulk-update",
    z.object({ ids: z.array(identifier).min(1).max(500), patch: taskPatch }),
    async ({ ids, patch }) => {
      const unique = [...new Set(ids)] as string[],
        candidate = structuredClone(state());
      const depth = (id: string) => {
        let count = 0,
          parent = candidate.tasks.find((task) => task.id === id)?.parentId;
        while (parent && count < 100) {
          count++;
          parent = candidate.tasks.find((task) => task.id === parent)?.parentId;
        }
        return count;
      };
      unique.sort((a, b) => depth(b) - depth(a));
      for (const id of unique) {
        const item = candidate.tasks.find((task) => task.id === id);
        if (!item) throw new Error("A selected story no longer exists.");
        applyTaskPatch(candidate, item, patch);
      }
      for (const id of unique)
        Object.assign(
          task(id),
          candidate.tasks.find((task) => task.id === id),
        );
      await changed();
    },
  );
  register("worker:open-folder", identifier, async (id) => {
    const item = task(id),
      path = item.run.workspace ?? item.run.worktree;
    if (!path) throw new Error("This story has no epic workspace yet.");
    await host.call("open_path", { path });
  });
  register(
    "preview:show",
    z.object({
      taskId: identifier,
      url: z.string().max(2000).optional(),
      artifactId: identifier.optional(),
      filePath: z.string().max(4000).optional(),
      fileRevision: z.string().max(200).optional(),
      commentId: identifier.optional(),
      commentFocus: z.number().int().min(0).optional(),
      line: z.number().int().min(1).max(10000000).optional(),
      bounds: z.object({
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        width: z.number().int().min(1),
        height: z.number().int().min(1),
      }),
    }),
    (input) => preview.show(input),
  );
  register(
    "browser:request",
    z.object({ taskId: identifier, request: browserRequestSchema }).strict(),
    ({ taskId, request }) => browsers.execute(taskId, request),
  );
  register("preview:hide", z.undefined(), () => preview.hide());
  register("worker:changes", identifier, async (id) => {
    const item = task(id);
    let changes = await readWorkerChanges(item);
    if (
      !changes.checkpoints.length &&
      item.run.baseline &&
      !item.run.changeRunId &&
      item.run.finishedAt
    ) {
      const scopes = item.scope ?? [];
      const overlap = state().tasks.some(
        (peer) =>
          peer.id !== id &&
          peer.projectId === item.projectId &&
          peer.run.startedAt &&
          peer.run.finishedAt &&
          peer.run.startedAt <= item.run.finishedAt! &&
          peer.run.finishedAt >= (item.run.startedAt ?? item.createdAt) &&
          (peer.scope ?? []).some((a) =>
            scopes.some(
              (b) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/"),
            ),
          ),
      );
      if (!overlap) {
        await new WorkerChangeJournal().importScopedBaseline(
          project(item.projectId),
          item,
        );
        changes = await readWorkerChanges(item);
        await changed();
      }
    }
    return changes;
  });
  register(
    "terminal:request",
    z.object({ taskId: identifier, request: terminalRequestSchema }).strict(),
    ({ taskId, request }) => terminals.execute(taskId, request),
  );
  register(
    "preview:action",
    z.enum(["back", "forward", "reload", "capture", "clear-selection"]),
    (input) => preview.action(input),
  );
  register(
    "speech:transcribe",
    z.string().min(60).max(28_000_000),
    async (value) => {
      const bytes = Buffer.from(value, "base64");
      if (
        bytes.length < 44 ||
        bytes.length > 20_000_000 ||
        bytes.toString("ascii", 0, 4) !== "RIFF" ||
        bytes.toString("ascii", 8, 12) !== "WAVE"
      )
        throw new Error("Dictation requires a WAV recording under 20 MB.");
      const form = new FormData();
      form.append(
        "file",
        new Blob([Uint8Array.from(bytes)], { type: "audio/wav" }),
        "dictation.wav",
      );
      form.append("response_format", "json");
      let response: Response;
      try {
        response = await fetch(localURL(store.state.settings.speechEndpoint), {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(120000),
          redirect: "error",
        });
      } catch {
        throw new Error(
          "Start the local Whisper server or update Local dictation in Settings.",
        );
      }
      if (!response.ok)
        throw new Error(`Local transcription failed (${response.status}).`);
      const result = (await response.json()) as { text?: string };
      if (!result.text?.trim()) throw new Error("No speech was detected.");
      return result.text.trim();
    },
  );
  register(
    "window:action",
    z.enum(["minimize", "maximize", "close"]),
    (action) => host.call("window_action", { action }),
  );
  await createExampleArtifacts(store);
  await changed();
  let closed = false;
  return {
    store,
    async openProject(path: string, name?: string, description = "") {
      const parent = await realpath(path);
      if (!(await stat(parent)).isDirectory())
        throw Error("Choose a project folder.");
      // A path supplied to the desktop launch command is explicit folder intent,
      // equivalent to selecting that folder in the native picker.
      selectedFolders.add(parent);
      return handlers.get("project:create")!.handle({
        mode: "existing",
        parent,
        name: name || basename(parent),
        description,
      }) as Promise<Project>;
    },
    async request(method: string, input?: unknown) {
      const route = handlers.get(method);
      if (!route) throw new Error(`Unknown MemCode method: ${method}`);
      const value =
        input === null && route.schema.safeParse(undefined).success
          ? undefined
          : input;
      return route.handle(route.schema.parse(value));
    },
    async close() {
      if (closed) return;
      closed = true;
      await workers.close();
      await terminals.close();
      await browsers.close();
      await preview.close();
      await engine.close();
      await store.save();
    },
  };
}
