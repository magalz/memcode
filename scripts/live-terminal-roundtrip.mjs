import { chromium, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const root = resolve("../memcode-browser-lab"),
  file = join(root, ".memcode/evidence/same-file-proof.json"),
  manifest = JSON.parse(await readFile(file, "utf8"));
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
const startedAt = new Date().toISOString(),
  records = [],
  deadline = Date.now() + 240000;
while (records.length < manifest.workers.length && Date.now() < deadline) {
  for (const worker of manifest.workers.filter(
    (w) => !records.some((r) => r.harness === w.harness),
  )) {
    const list = await call("terminal", worker.taskId, { action: "list" });
    const session = list.sessions.find(
      (s) =>
        s.origin === "worker" &&
        s.status === "running" &&
        s.startedAt >= startedAt,
    );
    if (!session) continue;
    const output = await call("terminal", worker.taskId, {
      action: "observe",
      sessionId: session.id,
    });
    if (!output.text?.includes("Live " + worker.harness + " dev server"))
      continue;
    const draftField = main.locator('textarea[aria-label="Message to worker"]');
    if ((await draftField.count()) && (await draftField.inputValue()).trim())
      throw Error("Preserving a user draft before terminal interaction.");
    if (await main.locator(".detail-overlay").count())
      await main
        .getByRole("button", { name: "Close work item", exact: true })
        .click();
    await main
      .getByRole("button", { name: "Conversations", exact: true })
      .click();
    const { state } = await call("load"),
      task = state.tasks.find((t) => t.id === worker.taskId);
    await main
      .getByRole("button")
      .filter({ hasText: task.title })
      .first()
      .click();
    await main.getByRole("button", { name: "Terminal", exact: true }).click();
    await expect(
      main.locator(".terminal-tab").filter({ hasText: session.label }).last(),
    ).toBeVisible();
    await main
      .locator(".terminal-tab")
      .filter({ hasText: session.label })
      .last()
      .getByRole("tab")
      .click();
    await call("hidePreview");
    await main.locator(".terminal-surface .xterm").click();
    const message = "human-" + manifest.token + "-" + worker.harness;
    await main.keyboard.type("ping " + message);
    await main.keyboard.press("Enter");
    await expect
      .poll(
        async () =>
          (
            await call("terminal", worker.taskId, {
              action: "observe",
              sessionId: session.id,
            })
          ).text,
        { timeout: 10000 },
      )
      .toContain("Terminal echo (" + worker.harness + "): " + message);
    await main.screenshot({
      path: join(
        root,
        ".memcode/evidence",
        worker.harness + "-managed-terminal.png",
      ),
    });
    const record = {
      harness: worker.harness,
      taskId: worker.taskId,
      sessionId: session.id,
      pid: session.pid,
      message,
      input: "actual card keyboard",
      at: new Date().toISOString(),
    };
    records.push(record);
    await writeFile(
      join(root, ".memcode/evidence/terminal-roundtrip-inputs.json"),
      JSON.stringify({ startedAt, records }, null, 2),
    );
    console.log(JSON.stringify(record));
  }
  if (records.length < manifest.workers.length)
    await new Promise((r) => setTimeout(r, 400));
}
if (records.length !== manifest.workers.length)
  throw Error("Not all real harnesses started a managed terminal.");
console.log("Typed and observed input in all three real managed PTYs.");
process.exit(0);
