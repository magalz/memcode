import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9329");
const main = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => p.url().includes("tauri.localhost"));
const call = (method, ...args) =>
  main.evaluate(({ method, args }) => window.memcode[method](...args), {
    method,
    args,
  });
const { state } = await call("load"),
  task = state.tasks.find(
    (t) => t.id === "d1ed4ddd-bf1b-47a7-a9f8-097506f47096",
  );
if (!task) throw Error("Original Codex demo is missing.");
const dir = resolve("../memcode-browser-lab/.memcode/evidence");
await mkdir(dir, { recursive: true });
await call("selectProject", task.projectId);
if (
  !(await main.getByRole("heading", { name: task.title, exact: true }).count())
) {
  if (await main.locator(".detail-overlay").count())
    await main
      .getByRole("button", { name: "Close work item", exact: true })
      .click();
  await main.getByRole("button", { name: "Workspace", exact: true }).click();
  await main
    .getByRole("button")
    .filter({ hasText: task.title })
    .first()
    .click();
}
await main.getByRole("button", { name: "Conversation", exact: true }).click();
const session = await call("terminal", task.id, {
  action: "start",
  label: "Shared terminal proof",
  program: "node",
  args: [
    "-e",
    "process.stdout.write('\\x1b[32mShared PTY ready ✓\\x1b[0m\\r\\n');process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{process.stdout.write('SAME PROCESS: '+d.trim()+'\\r\\n')})",
  ],
});
const id = session.session.id;
try {
  await expect
    .poll(
      async () => {
        const r = await call("terminal", task.id, {
          action: "observe",
          sessionId: id,
        });
        return r.text;
      },
      { timeout: 5000 },
    )
    .toContain("Shared PTY ready");
  await main.getByRole("button", { name: "Terminal", exact: true }).click();
  await main
    .getByRole("tab", { name: /Shared terminal proof/ })
    .click({ timeout: 10000 });
  await main.locator(".terminal-surface .xterm").click();
  await main.keyboard.type("human-through-card");
  await main.keyboard.press("Enter");
  await expect
    .poll(
      async () => {
        const r = await call("terminal", task.id, {
          action: "observe",
          sessionId: id,
        });
        return r.text;
      },
      { timeout: 10000 },
    )
    .toContain("SAME PROCESS: human-through-card");
  await call("terminal", task.id, {
    action: "write",
    sessionId: id,
    data: "worker-through-same-session\r",
  });
  await expect
    .poll(
      async () => {
        const r = await call("terminal", task.id, {
          action: "observe",
          sessionId: id,
        });
        return r.text;
      },
      { timeout: 10000 },
    )
    .toContain("SAME PROCESS: worker-through-same-session");
  await main.waitForTimeout(250);
  const fits = await main.locator(".terminal-mount").evaluate((host) => {
    const screen = host.querySelector(".xterm-screen").getBoundingClientRect(),
      bounds = host.getBoundingClientRect();
    return {
      height: screen.height,
      available: host.clientHeight,
      bottom: screen.bottom <= bounds.bottom + 0.5,
      width: screen.width <= host.clientWidth,
    };
  });
  assert.ok(fits.bottom && fits.width, JSON.stringify(fits));
  const after = (
    await call("terminal", task.id, { action: "observe", sessionId: id })
  ).session.seq;
  await main.getByRole("button", { name: "Conversation", exact: true }).click();
  await main.getByRole("button", { name: "Terminal", exact: true }).click();
  const restored = await call("terminal", task.id, {
    action: "observe",
    sessionId: id,
  });
  assert.equal(restored.session.pid, session.session.pid);
  assert.ok(restored.session.seq >= after);
  await main.screenshot({ path: join(dir, "terminal-card.png") });
  await main.getByRole("button", { name: "Changes", exact: true }).click();
  await expect(
    main.getByRole("region", { name: "Worker changes" }),
  ).toBeVisible();
  const scroll = main.locator(".change-patch-scroll");
  await expect(scroll).toBeVisible();
  await expect
    .poll(() => main.locator(".change-line code .token").count())
    .toBeGreaterThan(1);
  const horizontal = await scroll.evaluate((element) => {
    element.scrollLeft = 150;
    const row = element.querySelector(".change-line.add");
    const gutter = row.querySelector(".change-gutter");
    return {
      left: element.scrollLeft,
      viewportHeight: element.clientHeight,
      visibleBottom: element.getBoundingClientRect().bottom,
      contentHeight: element.scrollHeight,
      fullWidth: row.getBoundingClientRect().width >= element.scrollWidth - 20,
      gutterFixed:
        Math.abs(
          gutter.getBoundingClientRect().left -
            element.getBoundingClientRect().left,
        ) < 5,
    };
  });
  assert.ok(
    horizontal.left > 0 && horizontal.fullWidth && horizontal.gutterFixed,
    JSON.stringify(horizontal),
  );
  assert.equal(
    await main.getByText(/Combined changes on the epic branch/).count(),
    0,
  );
  const changes = await call("workerChanges", task.id);
  assert.ok(changes.files >= 1);
  assert.ok(
    changes.checkpoints.every((c) =>
      c.files.every((f) => f.path.startsWith("apps/codex/")),
    ),
  );
  await main.screenshot({ path: join(dir, "worker-changes-card.png") });
  await main
    .getByRole("dialog")
    .getByRole("button", { name: /^Artifacts/ })
    .click();
  await main
    .getByRole("button")
    .filter({ hasText: "codex-report.md" })
    .first()
    .click();
  let document;
  await expect
    .poll(async () => {
      document = browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => /\/p\/[^/]+\/index.html/.test(p.url()));
      return !!document;
    })
    .toBe(true);
  await expect(document.locator(".markdown-document h1")).toBeVisible({
    timeout: 10000,
  });
  assert.equal(await document.evaluate(() => !!window.memcode), false);
  await document.screenshot({ path: join(dir, "markdown-artifact.png") });
  const result = {
    passed: true,
    terminal: {
      pid: session.session.pid,
      nativePty: true,
      humanInput: true,
      workerInput: true,
      tabPersistence: true,
      heightFits: fits.bottom,
      widthFits: fits.width,
    },
    changes: {
      files: changes.files,
      source: "card scope",
      branchWideWarning: false,
    },
    markdown: { rendered: true, isolated: true },
    at: new Date().toISOString(),
  };
  await writeFile(
    join(dir, "card-features.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await call("terminal", task.id, { action: "close", sessionId: id }).catch(
    () => {},
  );
  assert.ok(
    !(await call("terminal", task.id, { action: "list" })).sessions.some(
      (s) => s.id === id,
    ),
    "Closed terminal was removed",
  );
}
process.exit(0);
