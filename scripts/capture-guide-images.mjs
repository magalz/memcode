// Capture real UI from an already-running, disposable native QA profile.
// This script never starts MemCode, coding workers, model calls or sign-in flows.
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, copyFile, access } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const portText = option("--port");
assert.match(portText ?? "", /^\d{1,5}$/, "Pass the independent QA --port.");
const port = Number(portText);
assert.ok(
  port > 0 && port < 65536 && port !== 9329,
  "Never attach to production CDP 9329.",
);
const output = resolve("public/guide");
const evidenceOutput = resolve("../tmp/memcode-guide");
const suppliedEvidence = option("--evidence-dir");
const only = option("--only")?.split(",");
const records = only
  ? JSON.parse(
      await readFile(join(evidenceOutput, "capture-report.json"), "utf8"),
    ).records.filter((record) => !only.includes(record.name))
  : [];
const failures = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const inside = (parent, child) => {
  const part = relative(resolve(parent), resolve(child));
  return part === "" || (!part.startsWith("..") && !isAbsolute(part));
};
await mkdir(output, { recursive: true });
await mkdir(evidenceOutput, { recursive: true });
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
let ownTerminal;
let main;
let qaProject;
let story;
let ownIllustrationServer;
try {
  await expect
    .poll(() => {
      main = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((page) => page.url().includes("tauri.localhost"));
      return !!main;
    })
    .toBeTruthy();
  await main.waitForFunction(() => !!window.memcode);
  await main.emulateMedia({ reducedMotion: "reduce" });
  main.setDefaultTimeout(12000);
  // The allowlist deliberately excludes startWorker, sendFollowup, connection
  // approval, sign-in, settings saves and every model/transcription operation.
  const allowed = new Set([
    "load",
    "selectProject",
    "resolveFile",
    "addMessage",
    "terminal",
    "browser",
    "hidePreview",
  ]);
  const call = (method, ...values) => {
    assert.ok(allowed.has(method), `Not a guide-capture operation: ${method}`);
    return main.evaluate(
      ({ method, values }) => window.memcode[method](...values),
      { method, values },
    );
  };
  const load = async () => (await call("load")).state;
  let state = await load();
  qaProject = state.projects.find(
    (project) =>
      project.id === option("--project") &&
      project.path &&
      inside(tmpdir(), project.path),
  );
  if (!qaProject && !option("--project")) {
    qaProject = state.projects.find(
      (project) =>
        !project.example &&
        project.path &&
        inside(tmpdir(), project.path) &&
        /memcode|onboarding/i.test(project.path),
    );
  }
  assert.ok(
    qaProject,
    "A disposable MemCode project under the OS temporary directory is required.",
  );
  assert.ok(
    !state.tasks.some(
      (task) =>
        !task.example &&
        ["preparing", "running", "stopping"].includes(task.run.state),
    ),
    "QA must have no running coding workers.",
  );
  story =
    state.tasks.find(
      (task) =>
        task.projectId === qaProject.id &&
        (option("--task")
          ? task.id === option("--task")
          : task.title.includes("welcoming")),
    ) ??
    state.tasks.find(
      (task) => task.projectId === qaProject.id && !task.example,
    );
  assert.ok(story, "The onboarding smoke-test story is required.");
  const click = async (locator) => {
    await expect(locator).toBeVisible();
    await expect(locator).toBeEnabled();
    await locator.evaluate((element) => element.click());
    await sleep(160);
  };
  const workDialog = () => main.locator(".work-detail");
  const closeCard = async () => {
    const close = main.getByRole("button", {
      name: "Close work item",
      exact: true,
    });
    if (await close.count()) await click(close);
    await call("hidePreview").catch(() => {});
  };
  const stopGuide = async () => {
    const pause = main.getByRole("button", {
      name: "Pause getting started guide",
      exact: true,
    });
    if (await pause.count()) await click(pause);
    const explore = main.getByRole("button", {
      name: "Explore on my own",
      exact: true,
    });
    if (await explore.count()) await click(explore);
  };
  const nav = async (name) => {
    await closeCard();
    await click(
      main
        .locator(".sidebar")
        .getByRole("button", { name: new RegExp(`^${name}(?:\\s*\\d+)?$`) }),
    );
    await sleep(250);
  };
  const select = async (project) => {
    await closeCard();
    await call("selectProject", project.id);
    await sleep(220);
  };
  const capture = async (
    name,
    locator,
    description,
    sourceProject = qaProject,
  ) => {
    await expect(locator).toBeVisible();
    await locator.screenshot({
      path: join(output, `${name}.png`),
      animations: "disabled",
    });
    records.push({
      name,
      description,
      source: sourceProject.example
        ? "Built-in Design preview (seeded examples)"
        : "Disposable onboarding QA project",
      project: sourceProject.name,
    });
    console.log(`Captured ${name}`);
  };
  const copy = async (name, existing, description) => {
    assert.ok(
      records.some((record) => record.name === existing),
      `Missing authentic source ${existing}`,
    );
    await copyFile(
      join(output, `${existing}.png`),
      join(output, `${name}.png`),
    );
    records.push({
      ...records.find((record) => record.name === existing),
      name,
      description,
      sameFrameAs: existing,
    });
  };
  const attempt = async (name, action) => {
    if (only && !only.includes(name)) return;
    try {
      await action();
    } catch (error) {
      failures.push({ name, error: error.message });
      console.error(`Could not capture ${name}: ${error.message}`);
      await call("hidePreview").catch(() => {});
      await main.keyboard.press("Escape").catch(() => {});
    }
  };
  const openStory = async () => {
    await select(qaProject);
    await nav("Conversations");
    await click(
      main.getByRole("button").filter({ hasText: story.title }).first(),
    );
    await expect(workDialog()).toBeVisible();
  };
  const tab = async (name) => {
    await click(
      workDialog()
        .getByRole("button", { name: new RegExp(`^${name}(?:\\s|$)`) })
        .first(),
    );
    await sleep(260);
  };
  await stopGuide();
  await select(qaProject);

  // The board and planning examples are the app's labelled Design preview,
  // not claims about live delivery, token savings or code quality.
  const preview = state.projects.find((project) => project.example);
  const overviewProject = preview ?? qaProject;
  await select(overviewProject);
  for (const [name, label, description] of [
    [
      "workspace",
      "Workspace",
      "Board and lane layout; cards are built-in example data where Design preview is available.",
    ],
    [
      "conversations",
      "Conversations",
      "Actual conversations overview in the labelled example project.",
    ],
    [
      "cycles",
      "Cycles",
      "Cycles UI and its current seeded or empty state; no delivery result was fabricated.",
    ],
    [
      "decisions",
      "Decisions",
      "Fleet decisions page, including its current empty/example state.",
    ],
    [
      "activity",
      "Activity",
      "Actual activity view; example activity is not a live worker run.",
    ],
    [
      "insights",
      "Insights",
      "Code intelligence UI in its current example/empty state; displayed records are not a new measurement.",
    ],
    [
      "improve",
      "Improve",
      "Current improvement UI; no analysis or model was started for this image.",
    ],
  ])
    await attempt(name, async () => {
      await nav(label);
      await capture(
        name,
        main.locator(".main-workspace"),
        description,
        overviewProject,
      );
    });
  await attempt("delivery", async () => {
    await nav("Insights");
    await click(main.getByRole("tab", { name: "Delivery", exact: true }));
    await capture(
      "delivery",
      main.locator(".main-workspace"),
      "Delivery charts in the labelled example/current empty state; no claimed performance improvement.",
      overviewProject,
    );
  });
  await select(qaProject);
  await attempt("roadmap", async () => {
    await nav("Roadmap");
    await capture(
      "roadmap",
      main.locator(".main-workspace"),
      "Real epic created by the onboarding smoke test, with a deliberately unfinished QA prerequisite.",
    );
  });
  await attempt("project", async () => {
    await nav("Workspace");
    await click(main.locator('[data-guide="project-picker"]'));
    await click(
      main.getByRole("button", { name: "Add a project", exact: true }),
    );
    const dialog = main.getByRole("dialog", {
      name: "A place for what comes next.",
    });
    await capture(
      "project",
      dialog,
      "Actual create/open project dialog. No project is created by this capture script.",
    );
    await click(
      dialog.getByRole("button", { name: "Close dialog", exact: true }),
    );
  });
  await attempt("workers", async () => {
    await nav("Workers");
    const candidates = main
      .locator(".worker-connection-card")
      .getByRole("button", { name: /^Connect / });
    let candidate;
    for (const button of await candidates.all())
      if (await button.isEnabled()) {
        candidate = button;
        break;
      }
    if (candidate) {
      await click(candidate);
      const consent = main.locator(".connection-consent");
      await expect(consent.getByRole("checkbox")).not.toBeChecked();
      await capture(
        "workers",
        consent,
        "Actual unchecked worker approval dialog. The capture does not grant access, authenticate or start work.",
      );
      await click(
        consent.getByRole("button", {
          name: "Close connection approval",
          exact: true,
        }),
      );
    } else {
      await capture(
        "workers",
        main.locator('[data-guide="worker-connections"]'),
        "Actual installed/approved worker connection states; no approval was performed for this image.",
      );
    }
  });
  await attempt("account", async () => {
    await nav("Workspace");
    await click(
      main.getByRole("button", { name: "Memtrace account", exact: true }),
    );
    const account = main.locator(".account-popover");
    await expect(account.locator(".account-status")).not.toContainText(
      "Checking Memtrace",
      { timeout: 20000 },
    );
    await capture(
      "account",
      account,
      "Actual read-only status of the installed Memtrace session. No sign-in was initiated; a valid license/session is not presented as a verified person identity.",
    );
    await click(
      account.getByRole("button", {
        name: "Close Memtrace account",
        exact: true,
      }),
    );
  });
  await attempt("dictation", async () => {
    await nav("Workspace");
    await click(
      main
        .locator(".sidebar")
        .getByRole("button", { name: "Settings", exact: true }),
    );
    const section = main.locator('[data-guide="dictation-settings"]');
    await section.scrollIntoViewIfNeeded();
    await capture(
      "dictation",
      section,
      "Actual local dictation setup/status. This capture never downloads a model, records audio or changes settings.",
    );
    await click(
      main
        .getByRole("dialog")
        .getByRole("button", { name: "Close dialog", exact: true }),
    );
  });

  await openStory();
  await attempt("story", async () => {
    await tab("Conversation");
    await capture(
      "story",
      workDialog(),
      "Actual brief-only onboarding story. Its worker has not been started.",
    );
    await copy(
      "routing",
      "story",
      "The same actual story inspector shows measured/provisional routing state honestly; no route metrics were injected.",
    );
  });
  await attempt("comments", async () => {
    await tab("Comments");
    await capture(
      "comments",
      workDialog(),
      "Story discussion created by the native onboarding test, including an owned edit and deleted-reply tombstone. These are discussion comments, not worker prompts.",
    );
  });
  await attempt("queue", async () => {
    await tab("Queue");
    await capture(
      "queue",
      workDialog(),
      "Actual follow-up queue after the native smoke test. A prerequisite prevented dispatch and the test cancelled its request; no model ran.",
    );
  });
  await attempt("changes", async () => {
    await tab("Changes");
    await expect(workDialog().locator(".spinner")).toHaveCount(0, {
      timeout: 20000,
    });
    await capture(
      "changes",
      workDialog(),
      "Actual Changes state for a story with no coding run. An empty state is intentional; there is no fabricated worker diff.",
    );
  });
  await attempt("artifacts", async () => {
    await tab("Artifacts");
    await capture(
      "artifacts",
      workDialog(),
      "Actual saved-output list/empty state for the QA story. No fabricated agent-generated artifacts.",
    );
  });

  await attempt("terminal", async () => {
    const terminals = await call("terminal", story.id, { action: "list" });
    const shell =
      terminals.shells.find((entry) => /powershell/i.test(entry.name)) ??
      terminals.shells[0];
    assert.ok(shell, "No local shell available in QA");
    const started = await call("terminal", story.id, {
      action: "start",
      shellId: shell.id,
      label: "Guide illustration",
      cwd: qaProject.path,
    });
    ownTerminal = started.session?.id;
    assert.ok(ownTerminal, "Own guide terminal did not start");
    await tab("Terminal");
    await expect(workDialog().locator(".xterm")).toBeVisible();
    // Only an ordinary directory listing in our disposable QA project.
    await call("terminal", story.id, {
      action: "write",
      sessionId: ownTerminal,
      data: /powershell/i.test(shell.name) ? "Get-ChildItem -Name" : "ls",
      submit: true,
    });
    await sleep(800);
    await capture(
      "terminal",
      workDialog(),
      "Actual local user terminal in the disposable QA project, displaying a directory listing. It is not a coding worker's tool log or dev server.",
    );
    await call("terminal", story.id, {
      action: "close",
      sessionId: ownTerminal,
    });
    ownTerminal = undefined;
  });

  await attempt("annotations", async () => {
    const sourceName = "index.ts";
    const file = await call("resolveFile", story.id, sourceName);
    assert.ok(
      inside(qaProject.path, file.path),
      "Reference escaped QA project",
    );
    const content = await readFile(file.path, "utf8");
    const quote = content.split(/\r?\n/).find((line) => line.trim());
    assert.ok(quote, "QA source has no readable line");
    state = await load();
    const existing = state.tasks
      .find((task) => task.id === story.id)
      .messages.some(
        (message) =>
          message.text === "Guide illustration: review this project source.",
      );
    if (!existing)
      await call(
        "addMessage",
        story.id,
        "Guide illustration: review this project source.",
        [
          {
            kind: "file",
            taskId: story.id,
            name: sourceName,
            path: file.path,
            revision: file.revision,
            quote,
            lineStart: 1,
            lineEnd: 1,
            selectionType: "lines",
          },
        ],
      );
    await tab("Conversation");
    await click(
      workDialog()
        .locator(".message-review-ref")
        .filter({ hasText: sourceName })
        .last(),
    );
    let guest;
    await expect
      .poll(() => {
        guest = browser
          .contexts()
          .flatMap((context) => context.pages())
          .find(
            (page) =>
              page !== main &&
              /127\.0\.0\.1|localhost/.test(page.url()) &&
              /\/p\//.test(page.url()),
          );
        return !!guest;
      })
      .toBeTruthy();
    await guest
      .getByRole("button", { name: "Comment on line 1", exact: true })
      .click();
    await guest
      .getByRole("button", { name: "Comment on selection", exact: true })
      .click();
    const composer = main.getByRole("region", {
      name: "New annotation",
      exact: true,
    });
    await expect(composer).toBeVisible();
    await capture(
      "annotations",
      composer,
      "Actual line-number selection from index.ts in the QA project, with its exact quote in the unsent annotation composer. No comment or follow-up is submitted.",
    );
    await click(
      composer.getByRole("button", { name: "Cancel annotation", exact: true }),
    );
  });

  await attempt("browser", async () => {
    if (!(await workDialog().count())) await openStory();
    await tab("Browser");
    let url = "http://127.0.0.1:58415";
    let description =
      "Actual native guest page of the existing owned Atelier local demo on port 58415, opened in this QA card.";
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(800) });
      assert.ok(response.ok);
    } catch {
      // A clearly labelled real static page, only when the existing demo is off.
      // It is served from memory and never written into the user's repository.
      const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Local browser illustration</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>
      *{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f5f8f3;color:#17352b;font:15px/1.65 system-ui,sans-serif;padding:42px}main{max-width:820px;margin:auto}.eyebrow{font:10px ui-monospace,monospace;letter-spacing:.18em;color:#627f70}.dot{display:inline-block;background:#27b498;width:7px;height:7px;border-radius:50%;margin-right:8px}h1{font-size:clamp(32px,5vw,48px);letter-spacing:-.045em;line-height:1.12;margin:20px 0}p{max-width:570px;color:#698073}.panel{background:white;border:1px solid #dce6d9;border-radius:14px;padding:25px;margin-top:30px}label{display:block;font-size:12px;margin-bottom:7px}input{font:inherit;width:100%;border:1px solid #d8e4d5;background:#fcfdfb;border-radius:7px;padding:11px 14px;color:#17352b;outline-color:#20b498}button{font:600 12px system-ui;background:#173c2a;color:white;border:0;border-radius:7px;padding:11px 17px;margin-top:14px;cursor:pointer}.hint{font-size:11px;margin-top:23px;color:#8a9b8f}#reply{margin:13px 0 0;color:#237455;font-size:13px}</style><main><div class="eyebrow"><span class="dot"></span>MEMCODE / LOCAL BROWSER ILLUSTRATION</div><h1>A real page.<br>Right inside the story.</h1><p>Select this text, type below, or use the page controls. This is a live local page in MemCode’s native browser.</p><div class="panel"><label for="note">Try a page interaction</label><input id="note" value="Make the first version feel effortless."><button id="apply">Update the page</button><div id="reply" aria-live="polite">Ready for your input.</div></div><p class="hint">Temporary QA illustration · no coding agent is running · no project source changed</p></main><script>document.querySelector('#apply').onclick=()=>document.querySelector('#reply').textContent='Page updated: '+document.querySelector('#note').value;</script></html>`;
      ownIllustrationServer = createServer((_request, response) => {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(html);
      });
      await new Promise((done) =>
        ownIllustrationServer.listen(0, "127.0.0.1", done),
      );
      url = `http://127.0.0.1:${ownIllustrationServer.address().port}`;
      description =
        "Actual native guest page of a temporary, explicitly labelled local browser illustration, served only during capture. No coding agent is running and this is not evidence of agent/browser synchronization.";
    }
    await call("browser", story.id, {
      action: "open",
      url,
    });
    let guest;
    await expect
      .poll(
        () => {
          guest = browser
            .contexts()
            .flatMap((context) => context.pages())
            .find((page) => page !== main && page.url().startsWith(url));
          return !!guest;
        },
        { timeout: 20000 },
      )
      .toBeTruthy();
    await guest.waitForLoadState("domcontentloaded");
    await sleep(250);
    if (ownIllustrationServer) {
      await guest
        .getByRole("button", { name: "Update the page", exact: true })
        .click();
      await expect(guest.locator("#reply")).toContainText("Page updated:");
    }
    await capture(
      "browser",
      guest.locator("body"),
      description +
        " Native child WebViews are captured separately because a parent screenshot omits them; this is not a composite or a remote website.",
    );
    await main.screenshot({
      path: join(evidenceOutput, "browser-parent.png"),
      animations: "disabled",
    });
  });
  await closeCard();
  await nav("Docs");

  // Optional existing snapshots are only copied when the caller explicitly
  // supplies their evidence directory. They remain labelled smoke-test frames.
  if (suppliedEvidence) {
    for (const [name, candidate] of [
      ["queue", "queue.png"],
      ["comments", "comments.png"],
    ]) {
      if (records.some((record) => record.name === name)) continue;
      const source = resolve(suppliedEvidence, candidate);
      try {
        await access(source);
        await copyFile(source, join(output, `${name}.png`));
        records.push({
          name,
          source: "Explicitly supplied native onboarding QA evidence",
          description: `Unmodified smoke-test screenshot: ${candidate}.`,
          project: qaProject.name,
        });
      } catch {
        /* A missing optional snapshot does not invent a replacement. */
      }
    }
  }
} finally {
  if (ownTerminal && main && story) {
    await main
      .evaluate(
        ({ taskId, sessionId }) =>
          window.memcode.terminal(taskId, { action: "close", sessionId }),
        { taskId: story.id, sessionId: ownTerminal },
      )
      .catch(() => {});
  }
  // Disconnect CDP only; never close the QA native app or its browser pages.
  await browser.close();
  if (ownIllustrationServer)
    await new Promise((done) => ownIllustrationServer.close(done));
  const expected = [
    "workspace",
    "project",
    "workers",
    "roadmap",
    "story",
    "conversations",
    "queue",
    "comments",
    "routing",
    "changes",
    "annotations",
    "browser",
    "terminal",
    "artifacts",
    "dictation",
    "account",
    "cycles",
    "delivery",
    "insights",
    "improve",
    "decisions",
    "activity",
  ];
  const missing = expected.filter(
    (name) => !records.some((record) => record.name === name),
  );
  const lines = [
    "# Guide image sources",
    "",
    "These are unmodified screenshots of MemCode's actual native UI. They were captured from an independent disposable onboarding QA profile, never the user's production profile. Built-in Design preview content is seeded example content. A screenshot of a UI or empty state does not verify a model run, code quality or token-saving claim.",
    "",
    "The capture script does not launch coding models, grant worker access, sign in, record audio, download models or alter project source. It may add an ordinary file-reference message in the temporary QA story and open a local browser tab. It starts and closes only its own illustrative local terminal.",
    "",
    `Captured: ${new Date().toISOString()}`,
    "",
    "| Image | Source | What it shows |",
    "| --- | --- | --- |",
    ...records.map(
      (record) =>
        `| ${record.name}.png | ${record.source}${record.sameFrameAs ? `; same frame as ${record.sameFrameAs}.png` : ""} | ${record.description.replaceAll("|", "\\|")} |`,
    ),
  ];
  if (missing.length)
    lines.push(
      "",
      "Missing frames (not replaced with fabricated UI): " +
        missing.join(", ") +
        ".",
    );
  if (failures.length)
    lines.push(
      "",
      "## Capture limitations",
      "",
      ...failures.map(
        (failure) =>
          `- ${failure.name}: ${failure.error.replaceAll("\n", " ")}`,
      ),
    );
  await writeFile(join(output, "SOURCES.md"), lines.join("\n") + "\n");
  await writeFile(
    join(evidenceOutput, "capture-report.json"),
    JSON.stringify({ records, missing, failures }, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      captured: records.length,
      missing,
      failures: failures.map((failure) => failure.name),
    }),
  );
  if (missing.length) process.exitCode = 1;
}
