import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
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
const manifest = JSON.parse(
  await readFile(
    resolve("../memcode-browser-lab/.memcode/evidence/same-file-proof.json"),
    "utf8",
  ),
);
const directory = resolve("../memcode-browser-lab/.memcode/evidence");
await mkdir(directory, { recursive: true });
const results = [];
for (const worker of manifest.workers) {
  const { state } = await call("load"),
    task = state.tasks.find((t) => t.id === worker.taskId);
  const format = { codex: "xlsx", claude: "docx", cursor: "pptx" }[
      worker.harness
    ],
    artifact = state.artifacts.find(
      (a) => a.taskId === task.id && a.name.endsWith("." + format),
    );
  assert.ok(artifact, "Missing " + format + " artifact for " + worker.harness);
  const draftField = main.locator('textarea[aria-label="Message to worker"]');
  const drafts = (await draftField.count())
    ? await draftField.inputValue()
    : "";
  if (drafts.trim())
    throw Error("Preserving the user's draft before Office UI checks.");
  if (await main.locator(".detail-overlay").count())
    await main
      .getByRole("button", { name: "Close work item", exact: true })
      .evaluate(element => element.click());
  await call("selectProject", task.projectId);
  await main
    .getByRole("button", { name: "Conversations", exact: true })
    .evaluate(element => element.click());
  await main
    .getByRole("button")
    .filter({ hasText: task.title })
    .first()
    .evaluate(element => element.click());
  const before = (
    await call("browser", task.id, { action: "state" })
  ).state.tabs.map((t) => t.id);
  await main
    .getByRole("dialog")
    .getByRole("button", { name: /^Artifacts/ })
    .evaluate(element => element.click());
  await main
    .getByRole("dialog")
    .getByRole("button")
    .filter({ hasText: artifact.name })
    .first()
    .evaluate(element => element.click());
  let view;
  await expect
    .poll(
      async () => {
        view = browser
          .contexts()
          .flatMap((c) => c.pages())
          .find((p) => /\/p\/[^/]+\/index.html/.test(p.url()));
        return view?.url();
      },
      { timeout: 10000 },
    )
    .toBeTruthy();
  if (format === "xlsx") {
    await expect(
      view.getByRole("tab", { name: "Mission planner", exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await expect(view.locator(".sheet-grid")).toContainText(
      "ORBIT MISSION PLANNER",
    );
    await view.getByRole("tab", { name: "Destinations", exact: true }).evaluate(element => element.click());
    await expect(view.locator(".sheet-grid")).toContainText("Mars");
    await view
      .getByRole("tab", { name: "Mission planner", exact: true })
      .evaluate(element => element.click());
    await expect(view.locator(".sheet-grid")).toContainText("209940");
  } else if (format === "docx") {
    await expect(view.locator(".docx-wrapper")).toContainText(
      "Atelier creative brief",
      { timeout: 15000 },
    );
    await expect(view.locator(".docx-wrapper table")).toContainText(
      "Editorial poster",
    );
    assert.ok((await view.locator("section.docx").count()) > 0);
  } else {
    await expect(view.locator(".slide-stage")).toContainText("An ocean of", {
      timeout: 15000,
    });
    await view.getByRole("button", { name: "Next slide" }).evaluate(element => element.click());
    await expect(view.locator(".slide-stage")).toContainText(
      "See the work as it happens.",
    );
    await view.screenshot({ path: join(directory, "office-pptx-slide-2.png") });
    await view.getByRole("button", { name: "Previous slide" }).evaluate(element => element.click());
    await expect(view.locator(".slide-stage")).toContainText("An ocean of");
  }
  assert.equal(await view.evaluate(() => !!window.memcode), false);
  await view.screenshot({ path: join(directory, "office-" + format + ".png") });
  const after = (
    await call("browser", task.id, { action: "state" })
  ).state.tabs.map((t) => t.id);
  assert.deepEqual(
    after,
    before,
    "Opening an artifact must not create a live browser tab",
  );
  results.push({
    harness: worker.harness,
    format,
    artifact: artifact.name,
    rendered: true,
    isolated: true,
    browserUnchanged: true,
  });
}
await writeFile(
  join(directory, "office-views.json"),
  JSON.stringify(
    { passed: true, results, at: new Date().toISOString() },
    null,
    2,
  ),
);
console.log(JSON.stringify({ passed: true, results }, null, 2));
process.exit(0);
