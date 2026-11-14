// Operates the real development app through its typed application API.
// Do not close this CDP Browser: the user owns the running app.
import { chromium } from "playwright-core";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
const [action = "status", ...args] = process.argv.slice(2);
const root = resolve("../memcode-browser-lab");
const browser = await chromium.connectOverCDP("http://127.0.0.1:9329", {
  timeout: 10000,
});
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url().includes("tauri.localhost"));
if (!page) throw Error("The user's MemCode window is not open.");
await page.waitForFunction(() => !!window.memcode);
const call = (method, ...args) =>
  page.evaluate(({ method, args }) => window.memcode[method](...args), {
    method,
    args,
  });
const { state, runtime } = await call("load");
const project = state.projects.find(
  (project) =>
    project.path?.replaceAll("\\", "/").toLowerCase() ===
    root.replaceAll("\\", "/").toLowerCase(),
);
if (action === "status") {
  console.log(
    JSON.stringify(
      {
        projects: state.projects.map((p) => ({
          id: p.id,
          name: p.name,
          analysis: p.analysis,
        })),
        active: state.activeProjectId,
        workers: state.tasks
          .filter((t) =>
            ["running", "preparing", "stopping"].includes(t.run.state),
          )
          .map((t) => ({ id: t.id, title: t.title, state: t.run.state })),
        lab: project
          ? state.tasks
              .filter((t) => t.projectId === project.id)
              .map((t) => ({
                id: t.id,
                title: t.title,
                harness: t.harness,
                state: t.run.state,
                error: t.run.error,
                messages: t.messages
                  .slice(-3)
                  .map((m) => ({ role: m.role, text: m.text.slice(0, 800) })),
              }))
          : null,
        artifacts: project
          ? state.artifacts
              .filter((a) => a.projectId === project.id)
              .map((a) => ({ name: a.name, kind: a.kind, taskId: a.taskId }))
          : [],
      },
      null,
      2,
    ),
  );
} else if (action === "close") {
  if (
    state.tasks.some((t) =>
      ["running", "preparing", "stopping"].includes(t.run.state),
    )
  )
    throw Error("Active workers prevent a demo restart.");
  const drafts = await page
    .locator("textarea")
    .evaluateAll((nodes) =>
      nodes
        .map((n) => ({ value: n.value, placeholder: n.placeholder }))
        .filter((n) => n.value.trim()),
    );
  const saved = new Set(
    state.tasks.flatMap((t) => [t.description, (t.scope ?? []).join("\n")]),
  );
  if (drafts.some((d) => !saved.has(d.value)))
    throw Error(
      "An unsaved text draft prevents a demo restart: " +
        JSON.stringify(drafts.map((d) => d.placeholder)),
    );
  await call("windowAction", "close");
  console.log("MemCode closed gracefully; workspace preserved.");
} else {
  if (!project)
    throw Error(
      "Launch MemCode with MEMCODE_OPEN_PROJECT set to the lab folder first.",
    );
  await call("selectProject", project.id);
  if (action === "setup") {
    const active = state.tasks.some((t) =>
      ["running", "preparing", "stopping"].includes(t.run.state),
    );
    if (active) throw Error("Workers already active.");
    if (state.settings.maxWorkers < 3)
      await call("saveSettings", { ...state.settings, maxWorkers: 3 });
    const epic =
      state.epics.find(
        (e) =>
          e.projectId === project.id &&
          e.title === "Live browser & artifact studio",
      ) ??
      (await call("createEpic", {
        projectId: project.id,
        title: "Live browser & artifact studio",
        description:
          "Three actual installed harnesses; one shared epic branch. Separate live browser interaction from direct saved-artifact rendering.",
        phase: "now",
      }));
    const styles = {
      codex:
        "ORBIT / Observatory. Build a premium deep-space mission design studio: near-black blue, luminous cyan, elegant orbital SVG graphic, refined instrument typography, large editorial headings. Add working launch-window/filter controls, mission selection, and a data visualization that updates. Clearly label all mission values as demo data.",
      claude:
        "ATELIER / Color & form. Build an exceptional editorial creative studio: warm ivory, aubergine, acid-lime accent, oversized serif typography, sophisticated grid and beautiful SVG composition. Add palette selection and density/layout controls that visibly transform the composition. Label it a demo.",
      cursor:
        "TIDELINE / Ocean instruments. Build a striking modern environmental dashboard: deep navy, seafoam, pale sand, oversized editorial typography and a beautiful custom SVG tide/terrain visualization. Add working location, time-range and simulation controls; chart updates must be real UI behavior. Label all measurements as synthetic demo data.",
    };
    const models = {
      codex: "gpt-6.1-terra",
      claude: "sonnet",
      cursor: "composer-2.5",
    };
    for (const harness of ["codex", "claude", "cursor"]) {
      if (
        state.tasks.some(
          (t) => t.projectId === project.id && t.harness === harness,
        )
      )
        continue;
      const description = [
        styles[harness],
        "Make this visually exceptional and responsive at 800px width: deliberate hierarchy, crisp type, subtle motion respecting reduced-motion, strong contrast, fine borders and generous rhythm. Avoid generic cards, emojis and gradients everywhere. Self-contained HTML/CSS/JS/SVG only; no packages or remote assets.",
        "Edit only apps/" +
          harness +
          "/index.html, apps/" +
          harness +
          "/poster.svg and apps/" +
          harness +
          "/report.md, plus your own MEMCODE_ARTIFACT_DIR. Other Fleet workers own other apps.",
        "Produce THREE saved artifacts: (1) your complete interactive HTML app, (2) a beautiful standalone SVG editorial poster with a substantial custom composition and accessible title, (3) an honest report. Artifact HTML must work standalone without a server: handle fetch failure gracefully and explain that live worker messaging is available in the Browser tab.",
        "Separately launch the LIVE app yourself with node tools/lab.mjs start " +
          harness +
          ". Use its returned loopback URL in MemCode browser.open, then observe and exercise at least two real controls with MemCode browser.act. Capture a real screenshot. Do not open a private vendor browser.",
        "The live app MUST include an accessible textbox labelled 'Message for your worker', a 'Send note' button, an element id='user-note' that displays the submitted note as text, and an element id='worker-reply' for the reply. Send POST /note with JSON {note:<input value>} and content-type application/json; show the saved note visibly. Poll GET /reply every 1500ms and show .reply as plain text. GET /note on load restores .note. Do not use innerHTML for external text. In a saved standalone artifact, catch failures and keep every non-messaging interaction working.",
        "After building, opening, and checking the app, run node tools/lab.mjs wait " +
          harness +
          " 180 ONCE. This is a bounded local demo wait. The test driver/user will submit an in-scope note through the actual native browser. Once received, call MemCode browser.observe to verify the SAME note in the rendered page; quote it in your report. Make the requested small in-scope visual adjustment, respond via node tools/lab.mjs reply " +
          harness +
          ' "<your concise acknowledgement>", reload using MemCode browser.act, and observe/capture the real updated app. Browser user control may require waiting for Return to agent.',
        "Use node tools/lab.mjs publish " +
          harness +
          " after final edits to publish all three saved artifacts. Keep the loopback server and browser tab open for a user demo. Do not commit or change shared tools, test files, policies or Git state. Report actual checks, limitations and any denied operation.",
      ].join("\n\n");
      const task = await call("createTask", {
        projectId: project.id,
        epicId: epic.id,
        title: {
          codex: "Orbit — an observatory by Codex",
          claude: "Atelier — a creative studio by Claude Code",
          cursor: "Tideline — ocean instruments by Cursor",
        }[harness],
        description,
        priority: "high",
        harness,
        assignment: "manual",
        kind: "test",
      });
      await call("updateTask", task.id, {
        scope: [
          "apps/" + harness + "/index.html",
          "apps/" + harness + "/poster.svg",
          "apps/" + harness + "/report.md",
        ],
        modelOverride: models[harness],
        checklist: [
          {
            id: crypto.randomUUID(),
            text: "Build and launch a real interactive app in this card's browser",
            done: false,
          },
          {
            id: crypto.randomUUID(),
            text: "Observe the user's live note and reflect an in-scope change",
            done: false,
          },
          {
            id: crypto.randomUUID(),
            text: "Publish direct HTML, SVG and report artifacts",
            done: false,
          },
        ],
      });
      console.log(
        JSON.stringify({ created: task.id, harness, title: task.title }),
      );
    }
  } else if (action === "restore") {
    for (const task of state.tasks.filter(
      (task) => task.projectId === project.id && !task.parentId,
    )) {
      const meta = JSON.parse(
        await readFile(
          join(root, ".memcode", "lab", task.harness, "server.json"),
          "utf8",
        ),
      );
      await call("browser", task.id, { action: "open", url: meta.url });
    }
    console.log("Restored the three primary demo browsers.");
  } else if (action === "refresh") {
    await call("analyzeProject", project.id);
    await call("refreshFleet", project.id);
    console.log("Lab source analysis and Fleet state refreshed.");
  } else if (action === "resume") {
    const tasks = state.tasks.filter(
      (t) => t.projectId === project.id && (!args[0] || t.harness === args[0]),
    );
    for (const task of tasks) {
      if (["running", "preparing", "stopping"].includes(task.run.state))
        throw Error("This worker is active.");
      const evidenceRoot = join(root, ".memcode", "evidence");
      await mkdir(evidenceRoot, { recursive: true });
      const recorded = JSON.parse(
        await readFile(
          join(evidenceRoot, task.harness + "-interaction.json"),
          "utf8",
        ).catch(() => "null"),
      );
      const notePath = join(root, ".memcode", "lab", task.harness, "note.json");
      const note = JSON.parse(
        await readFile(notePath, "utf8").catch(() => "null"),
      );
      if (note && note.note === recorded?.note)
        await rename(
          notePath,
          join(
            evidenceRoot,
            task.harness + "-prior-note-" + Date.now() + ".json",
          ),
        );
      await call(
        "addMessage",
        task.id,
        "Continue the browser/artifact story after the interrupted first attempt. The MemCode Class B routing error is fixed. Use the provided coordinate tool BEFORE each source edit (inspect with a concrete plan; obey canEdit) and checkpoint afterward. Finish the two live control checks, wait once for a NEW note, verify it with browser.observe, reflect it in the source, reply, and publish all three saved artifacts. Preserve your visual design and other workers' files. Keep the server and tab open. For source edits, use your native patch/Edit/Write tool in small reviewable changes. Do not retry the denied combined PowerShell file-writing command or change permission policies. The already authorized node tools/lab.mjs start/wait/reply/publish commands handle the local demo lifecycle.",
      );
      console.log(JSON.stringify({ prepared: task.id, harness: task.harness }));
    }
  } else if (action === "start") {
    const task = state.tasks.find(
      (t) => t.projectId === project.id && t.harness === args[0],
    );
    if (!task) throw Error("Choose a lab harness.");
    await call("startWorker", task.id);
    console.log(JSON.stringify({ started: task.id, harness: task.harness }));
  } else if (action === "show") {
    const task = state.tasks.find(
      (t) => t.projectId === project.id && t.harness === args[0],
    );
    if (!task) throw Error("Choose a lab harness.");
    if (await page.locator(".work-detail").count())
      await page
        .getByRole("button", { name: "Back to workspace", exact: true })
        .click();
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page
      .getByRole("button")
      .filter({ hasText: task.title })
      .first()
      .click();
    await page
      .locator(".detail-tabs")
      .getByRole("button", { name: "Browser", exact: true })
      .click();
    console.log(JSON.stringify({ showing: task.id }));
  } else if (action === "interact") {
    const task = state.tasks.find(
      (t) => t.projectId === project.id && t.harness === args[0],
    );
    if (!task) throw Error("Choose a lab harness.");
    const current = await call("browser", task.id, { action: "state" });
    if (!current.state.nativeSurface || !current.state.tabs.length)
      throw Error("The worker has not opened its native app yet.");
    const meta = JSON.parse(
      await readFile(
        join(root, ".memcode", "lab", task.harness, "server.json"),
        "utf8",
      ),
    );
    const guest = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((p) => p.url() === meta.url + "/");
    if (!guest) throw Error("Actual native app page not found.");
    if (
      !(await guest
        .getByRole("textbox", { name: "Message for your worker", exact: true })
        .count())
    )
      throw Error("The worker has not created the collaboration form yet.");
    if (await page.locator(".work-detail").count())
      await page
        .getByRole("button", { name: "Back to workspace", exact: true })
        .click();
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page
      .getByRole("button")
      .filter({ hasText: task.title })
      .first()
      .click();
    await page
      .locator(".detail-tabs")
      .getByRole("button", { name: "Browser", exact: true })
      .click();
    await page.locator(".native-browser-surface").waitFor();
    await new Promise((done) => setTimeout(done, 400));
    const title = {
      codex: "ORBIT — In sync",
      claude: "ATELIER — In sync",
      cursor: "TIDELINE — In sync",
    }[task.harness];
    const note =
      'Please change the main page heading to "' +
      title +
      '". Keep the rest of the demo intact.';
    const before = await guest.locator("h1").first().textContent();
    await call("browser", task.id, { action: "control", value: "user" });
    await guest
      .getByRole("textbox", { name: "Message for your worker", exact: true })
      .fill(note);
    await guest.getByRole("button", { name: /^Send note/ }).click();
    await guest.waitForFunction(
      (note) =>
        document.querySelector("#user-note")?.textContent.includes(note),
      note,
      { timeout: 10000 },
    );
    await new Promise((done) => setTimeout(done, 300));
    const at = new Date().toISOString();
    await call("browser", task.id, { action: "control", value: "worker" });
    const evidence = {
      harness: task.harness,
      taskId: task.id,
      url: meta.url,
      nativeSurface: true,
      before,
      note,
      expectedHeading: title,
      userInputAt: at,
      tabIds: current.state.tabs.map((t) => t.id),
    };
    const evidenceRoot = join(root, ".memcode", "evidence");
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(
      join(evidenceRoot, task.harness + "-interaction.json"),
      JSON.stringify(evidence, null, 2),
    );
    console.log(JSON.stringify(evidence, null, 2));
  } else
    throw Error(
      "Use status, close, setup, start <harness>, or show <harness>.",
    );
}
process.exit(0);
