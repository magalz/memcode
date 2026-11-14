import { chromium } from "playwright-core";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
const action = process.argv[2] ?? "status",
  root = resolve("../memcode-browser-lab");
const directory = join(root, ".memcode", "evidence"),
  manifestPath = join(directory, "same-file-proof.json");
const browser = await chromium.connectOverCDP("http://127.0.0.1:9329");
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url().includes("tauri.localhost"));
if (!page) throw Error("MemCode is not open.");
const call = (method, ...args) =>
  page.evaluate(({ method, args }) => window.memcode[method](...args), {
    method,
    args,
  });
const { state } = await call("load"),
  project = state.projects.find(
    (p) =>
      p.path?.replaceAll("\\", "/").toLowerCase() ===
      root.replaceAll("\\", "/").toLowerCase(),
  );
if (!project) throw Error("The live lab project is missing.");
await mkdir(directory, { recursive: true });
let manifest = JSON.parse(
  await readFile(manifestPath, "utf8").catch(() => "null"),
);
if (action === "setup") {
  if (manifest)
    throw Error(
      "Preserving the existing proof manifest. Use status or verify.",
    );
  if (
    state.tasks.some((t) =>
      ["running", "preparing", "stopping"].includes(t.run.state),
    )
  )
    throw Error(
      "Finish active workers before preparing the shared-file proof.",
    );
  await mkdir(join(root, "shared"), { recursive: true });
  const source =
    "// MemCode Fleet handoff fixture. Preserve the helper and append only your adapter.\nexport const participants = [];\nexport function appendParticipant(values, name) {\n  if (values.includes(name)) return values;\n  return [...values, name];\n}\n";
  await writeFile(join(root, "shared", "participants.mjs"), source, {
    flag: "wx",
  });
  await copyFile(
    fileURLToPath(new URL("./fixtures/fleet-gate.mjs", import.meta.url)),
    join(root, "tools", "fleet-gate.mjs"),
  );
  const permissionsPath = join(root, ".claude", "settings.local.json"),
    settings = JSON.parse(await readFile(permissionsPath, "utf8"));
  settings.permissions.allow = [
    ...new Set([
      ...settings.permissions.allow,
      "Bash(node tools/fleet-gate.mjs:*)",
    ]),
  ];
  await writeFile(permissionsPath, JSON.stringify(settings, null, 2));
  const token = randomUUID(),
    workers = [];
  for (const harness of ["codex", "claude", "cursor"]) {
    const parent = state.tasks.find(
      (t) => t.projectId === project.id && t.harness === harness && !t.parentId,
    );
    if (!parent) throw Error("A lab app worker is missing.");
    const description = [
      "This is a REAL same-file Fleet handoff and background-browser verification. Preserve the completed demo app. All three workers intentionally share shared/participants.mjs on the same epic branch.",
      "Before any source edit, inspect Fleet with a concrete plan: preserve the participants array's existing entries and insertion order; each worker appends only its own adapter name, exactly once, after the previous owner releases the reservation. Preserve appendParticipant unchanged. Only edit shared/participants.mjs and apps/" +
        harness +
        "/report.md. Native patch/Edit tools are available; do not bypass a denied tool.",
      harness === "codex"
        ? "You are launched first. After obtaining canEdit=true, run node tools/fleet-gate.mjs " +
          token +
          ' ONCE. It holds the reservation until the other two real agents have explicitly adopted your published plan. While waiting you can independently verify the browser. Once the gate releases, re-inspect Fleet and append only "codex" to the array, preserving existing entries. Checkpoint after the source edit.'
        : "Read the earlier owner's plan. Adopt it with bounded waitMs (at most 20000) while you do independent browser verification. If the owner changes during handoff, inspect and explicitly adopt the new current owner's plan. Only edit with canEdit=true after re-reading the returned current source. Append only \"" +
          harness +
          '" exactly once, preserving earlier entries and order, then checkpoint. Ordinary overlap is not a human conflict. Propose a semantic alternative only if you actually disagree with the compatible shared contract.',
      "Independently use node tools/lab.mjs start " +
        harness +
        " to obtain the existing demo server URL. Open it with MemCode browser, observe, exercise two actual design controls, observe the resulting changes, and capture a real screenshot while the card is hidden. For an HTML select use browser.act choose with a current ref and option value/label; select is only for switching browser tabs. The native background screenshot fix is installed. Leave the server and tab open. Do not repeat the note wait or change the app's heading/design.",
      "Once you own the source reservation, inspect again before appending an honest section to apps/" +
        harness +
        "/report.md describing the source handoff, actual browser checks and capture results. Record a checkpoint after this report edit. Copy the updated report into your own MEMCODE_ARTIFACT_DIR as " +
        harness +
        "-fleet-verification.md using your native Write/patch tool. Preserve the earlier HTML/SVG saved outputs; do not republish them in this verification card. Run node --test lab.test.mjs. Report actual results and any blocker. Do not commit, switch branches or edit another worker's app.",
    ].join("\n\n");
    const task = await call("createTask", {
      projectId: project.id,
      parentId: parent.id,
      epicId: parent.epicId,
      title:
        "Prove Fleet handoff with " +
        { codex: "Codex", claude: "Claude Code", cursor: "Cursor" }[harness],
      description,
      priority: "high",
      harness,
      assignment: "manual",
      kind: "test",
    });
    await call("updateTask", task.id, {
      scope: ["shared/participants.mjs", "apps/" + harness + "/report.md"],
      modelOverride: {
        codex: "gpt-6-luna",
        claude: "haiku",
        cursor: "composer-2.5",
      }[harness],
    });
    workers.push({ taskId: task.id, harness, parentId: parent.id });
  }
  manifest = {
    token,
    root,
    projectId: project.id,
    workers,
    expected: ["codex", "claude", "cursor"],
    initialSource: source,
    createdAt: new Date().toISOString(),
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await call("analyzeProject", project.id);
  console.log(JSON.stringify(manifest, null, 2));
} else {
  if (!manifest) throw Error("Set up the shared-file proof first.");
  const audits = await Promise.all(
    manifest.workers.map(async (worker) => ({
      worker,
      events: (
        await readFile(
          join(
            root,
            ".memcode",
            "workers",
            worker.taskId,
            "fleet-activity.jsonl",
          ),
          "utf8",
        ).catch(() => "")
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    })),
  );
  if (action === "start") {
    const worker = manifest.workers.find((w) => w.harness === process.argv[3]);
    if (!worker) throw Error("Choose a proof harness.");
    await call("startWorker", worker.taskId);
    console.log(JSON.stringify({ started: worker }));
  } else if (action === "release") {
    const later = audits.filter((a) => a.worker.harness !== "codex");
    if (!later.every((a) => a.events.some((e) => e.request.action === "adopt")))
      throw Error(
        "Both later workers must actually adopt before releasing the first owner.",
      );
    const gate = join(root, ".memcode", "fleet-gate");
    await mkdir(gate, { recursive: true });
    await writeFile(
      join(gate, manifest.token + ".json"),
      JSON.stringify({
        token: manifest.token,
        release: true,
        at: new Date().toISOString(),
        reason: "Both real later workers made an adopt call.",
      }),
    );
    console.log("Released the first owner after two real adapter adoptions.");
  } else if (action === "prepare") {
    if (
      manifest.workers.some(
        (w) => state.tasks.find((t) => t.id === w.taskId)?.run.state !== "idle",
      )
    )
      throw Error("Prepare only unstarted proof workers.");
    for (const name of [
      "browser-lab-server.mjs",
      "office-builder.mjs",
      "office-document.py",
      "create-office-fixture.mjs",
    ]) {
      await copyFile(
        fileURLToPath(new URL("./fixtures/" + name, import.meta.url)),
        join(
          root,
          "tools",
          name === "browser-lab-server.mjs" ? "lab.mjs" : name,
        ),
      );
    }
    const settingsPath = join(root, ".claude", "settings.local.json"),
      settings = JSON.parse(await readFile(settingsPath, "utf8"));
    settings.permissions.allow = [
      ...new Set([
        ...settings.permissions.allow,
        "Bash(node tools/create-office-fixture.mjs:*)",
      ]),
    ];
    await writeFile(settingsPath, JSON.stringify(settings, null, 2));
    for (const worker of manifest.workers) {
      const task = state.tasks.find((t) => t.id === worker.taskId),
        h = worker.harness;
      const extra = [
        "UPDATED PERSISTENT TERMINAL AND OFFICE VERIFICATION (these server instructions replace the earlier detached 'lab.mjs start' instructions):",
        "Use the MemCode terminal tool for the real persistent dev server. List sessions first. Stop only the lab's old owned detached server using node tools/lab.mjs stop " +
          h +
          ". Start program=node, args=[tools/lab.mjs,serve," +
          h +
          "], label=" +
          {
            codex: "Orbit dev server",
            claude: "Atelier dev server",
            cursor: "Tideline dev server",
          }[h] +
          ". It prints its loopback URL and accepts commands. Do NOT detach it or redirect output. Open that URL with MemCode browser and leave the PTY and browser running when your turn ends.",
        "Use terminal.write to send ping worker-" +
          manifest.token +
          "-" +
          h +
          " followed by a newline, then terminal.observe and verify the matching echo. The test driver may also send ping human-" +
          manifest.token +
          "-" +
          h +
          " through the card UI. Observe the SAME session before reporting, quote any observed human marker, and preserve the terminal so the user can interact after your turn. Do not invent a marker you have not seen.",
        "Create one real Office artifact by running node tools/create-office-fixture.mjs " +
          h +
          " once. This host-prepared helper uses the bundled local document runtime, writes to your private MEMCODE_ARTIFACT_DIR, renders QA images and reports its output. It creates " +
          {
            codex: "an editable .xlsx mission planner",
            claude: "an editable .docx creative brief",
            cursor: "an editable .pptx presentation",
          }[h] +
          ". Report errors honestly. Do not replace Office files with HTML, rename another file's extension, or bypass a denied command.",
        "Keep the shared-source Fleet rules above. In the final report include actual browser, terminal, Office and test results. Save the Markdown verification report in your private artifact directory.",
      ].join("\n\n");
      await call("updateTask", task.id, {
        description: task.description + "\n\n" + extra,
      });
    }
    console.log(
      "Prepared three real workers for managed PTYs, Office artifacts and same-file Fleet attribution.",
    );
  } else if (action === "continue") {
    if (
      manifest.workers.some((w) =>
        ["running", "preparing", "stopping"].includes(
          state.tasks.find((t) => t.id === w.taskId)?.run.state,
        ),
      )
    )
      throw Error("Finish current proof workers before the continuation.");
    await copyFile(
      fileURLToPath(
        new URL("./fixtures/create-office-fixture.mjs", import.meta.url),
      ),
      join(root, "tools", "create-office-fixture.mjs"),
    );
    for (const worker of manifest.workers) {
      const h = worker.harness;
      await call("updateTask", worker.taskId, {
        scope: ["apps/" + h + "/report.md"],
      });
      const message = [
        "CONTINUATION: The same-file Fleet proof is COMPLETE and correct. Do not edit shared/participants.mjs. The current source scope is ONLY apps/" +
          h +
          "/report.md. Preserve the previous reports; append the corrected verification results and checkpoint.",
        "Two actual host bugs are now fixed: Windows ConPTY startup is answered even while the card is hidden, and terminal.start accepts either a real argument array or a JSON-encoded argument array string. Use the current MemCode terminal tool, not a detached fallback.",
        'List sessions. Start one managed PTY program=node with args=["tools/lab.mjs","serve","' +
          h +
          '"], label=' +
          {
            codex: "Orbit dev server",
            claude: "Atelier dev server",
            cursor: "Tideline dev server",
          }[h] +
          ". Observe until its real URL prints; open that URL with MemCode browser. Exercise two live controls and capture. Leave the actual managed process and browser open.",
        'Send terminal.write data="ping worker-' +
          manifest.token +
          "-" +
          h +
          '\\r". Observe the matching echo. The test driver will send a human marker; wait about 20 seconds using a short native sleep, then observe the SAME terminal before your final report. Only quote markers actually seen. Keep its sessionId and PID in the report. User and worker must control this exact process.',
        h === "cursor"
          ? "The Office helper's finalizer now has the required RUNTIME_NODE_MODULES environment. Run node tools/create-office-fixture.mjs cursor once to finish the real PPTX; report its output or actual error."
          : "Your real " +
            (h === "codex" ? "XLSX" : "DOCX") +
            " artifact already exists from the previous run. Preserve it; do not regenerate or rename it. The host is validating its rendered native preview. The unavailable optional LibreOffice QA converter does not mean the Word file was not created.",
        "Use MemCode coordinate inspect before the report source edit and checkpoint afterwards. Copy the report to your private artifact directory. Run node --test lab.test.mjs, report actual checks and remaining blockers, and exit without stopping the managed dev server.",
      ].join("\n\n");
      await call("addMessage", worker.taskId, message);
    }
    manifest.continuationAt = new Date().toISOString();
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(
      "Prepared the real harness continuation for the repaired hidden PTY and Office finalizer.",
    );
  } else if (action === "final") {
    if (
      manifest.workers.some((w) =>
        ["running", "preparing", "stopping"].includes(
          state.tasks.find((t) => t.id === w.taskId)?.run.state,
        ),
      )
    )
      throw Error("Finish the previous workers first.");
    await copyFile(
      fileURLToPath(
        new URL("./fixtures/browser-lab-server.mjs", import.meta.url),
      ),
      join(root, "tools", "lab.mjs"),
    );
    for (const w of manifest.workers) {
      const h = w.harness;
      await call("updateTask", w.taskId, {
        scope: ["apps/" + h + "/report.md"],
      });
      await call(
        "addMessage",
        w.taskId,
        [
          "FINAL LIVE VERIFICATION. The source handoff is complete. Only apps/" +
            h +
            "/report.md may be changed; never change participants.mjs. Re-read current participants if mentioning its content: the verified shared array has codex, claude AND cursor.",
          'The lab server\'s terminal-event logger was fixed to use append-only JSONL; its previous concurrent JSON rewrite could terminate a test server. List MemCode terminals, stop your previous running managed dev-server sessions, and start ONE new terminal program=node, args=["tools/lab.mjs","serve","' +
            h +
            '"], label=' +
            {
              codex: "Orbit dev server",
              claude: "Atelier dev server",
              cursor: "Tideline dev server",
            }[h] +
            ". Never detach. Observe and use the real URL printed by THIS process.",
          'Send terminal.write with data="ping worker-' +
            manifest.token +
            "-" +
            h +
            '" and submit=true. This sends real Enter; do not send literal backslash-r text. Verify its echo. A test driver is already waiting and will type ping human-' +
            manifest.token +
            "-" +
            h +
            " into the exact card terminal. Wait 20 seconds with a native sleep ONCE, then terminal.observe and quote both actual echoes. If missing, report the actual blocker. Leave the session running.",
          "Open THIS managed server URL with MemCode browser, observe its actual page, exercise one real design control and capture. Preserve headings and app source. No Office generation is needed; the existing xlsx/docx/pptx outputs are being checked by the host.",
          "Record the final evidence in your report (real sessionId, PID, URL, observed worker/human echoes, browser result). Use coordinate inspect before report edits and checkpoint after. Copy the report to your artifact directory, run node --test lab.test.mjs and finish, leaving the managed PTY/browser running. Keep final answer short and factual.",
        ].join("\n\n"),
      );
    }
    manifest.finalVerificationAt = new Date().toISOString();
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(
      "Prepared the final keyboard-to-harness verification with all three real adapters.",
    );
  } else if (action === "status")
    console.log(
      JSON.stringify(
        {
          workers: audits.map((a) => ({
            harness: a.worker.harness,
            task: state.tasks.find((t) => t.id === a.worker.taskId)?.run,
            events: a.events
              .slice(-6)
              .map((e) => ({
                action: e.request.action,
                directive: e.directive,
                owner: e.ownerTaskId,
              })),
          })),
          openHumanDecisions: state.fleetConflicts.filter(
            (c) => c.projectId === project.id && c.status === "open",
          ),
        },
        null,
        2,
      ),
    );
  else throw Error("Use setup, start <harness>, status or release.");
}
process.exit(0);
