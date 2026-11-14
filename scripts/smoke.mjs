import assert from "node:assert/strict";
import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const root = resolve(".");
const out = resolve(process.env.MEMCODE_REVIEW_DIR ?? "../tmp/memcode-review");
const profile = await mkdtemp(join(tmpdir(), "memcode-smoke-"));
await mkdir(out, { recursive: true });
const env = { ...process.env, MEMCODE_DATA_DIR: profile };
let server;
delete env.ELECTRON_RUN_AS_NODE;
let desktop;
const errors = [];
async function launch() {
  desktop = await electron.launch({
    executablePath: electronPath,
    args: [root],
    env,
    timeout: 30000,
  });
  const page = await desktop.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".app-shell", { timeout: 25000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => document.fonts.ready);
  return page;
}
const shot = async (page, name) =>
  page.screenshot({ path: join(out, name), animations: "disabled" });
try {
  if (process.env.MEMCODE_SMOKE_DEV === "1") {
    const { createServer } = await import("vite");
    server = await createServer();
    await server.listen();
    env.MEMCODE_DEV_URL = "http://127.0.0.1:5197";
  }
  let page = await launch();
  await expect(page.locator(".epic-card")).toHaveCount(9);
  let data = await page.evaluate(() => window.memcode.load());
  assert.equal(
    data.state.tasks.filter((t) => t.projectId === "memcode-dogfood").length,
    38,
  );
  assert.deepEqual(
    data.runtime.harnesses.map((h) => h.id),
    ["codex", "claude", "cursor"],
  );
  const cursorModels =
    data.runtime.harnesses.find((h) => h.id === "cursor")?.models ?? [];
  assert.equal(
    data.state.tasks.some((t) =>
      ["running", "preparing"].includes(t.run.state),
    ),
    false,
  );
  await shot(page, "09-roadmap.png");
  await page
    .getByRole("button", { name: "View stories", exact: true })
    .nth(2)
    .click();
  await shot(page, "10-epic-stories.png");

  await page.getByRole("button", { name: "New epic", exact: true }).click();
  await page
    .getByLabel("Epic name", { exact: true })
    .fill("Smoke check · saved epic");
  await page
    .getByLabel("Epic description", { exact: true })
    .fill("A persisted UI acceptance check.");
  await page
    .getByRole("combobox", { name: "Roadmap phase", exact: true })
    .click();
  await page.getByRole("option", { name: /Next/ }).click();
  await page.getByRole("button", { name: "Create epic", exact: true }).click();
  await expect(page.locator(".epic-card")).toHaveCount(10);
  await page.getByRole("button", { name: /New story/ }).click();
  await page
    .getByLabel("Work item title", { exact: true })
    .fill("Smoke check · saved story");
  await page
    .getByLabel("Work item brief", { exact: true })
    .fill("Verify roadmap, selectors, model assignment, and persistence.");
  await page
    .getByRole("combobox", { name: "Worker harness", exact: true })
    .click();
  await expect(page.getByRole("option")).toHaveCount(4);
  await shot(page, "11-worker-selector.png");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("combobox", { name: "Story epic", exact: true }).click();
  await page.getByRole("option", { name: /Smoke check · saved epic/ }).click();
  await page
    .getByRole("button", { name: "Create work item", exact: true })
    .click();
  await expect(page.locator(".work-detail")).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Assigned harness", exact: true }),
  ).toContainText("Automatic");
  await page
    .getByRole("combobox", { name: "Assigned harness", exact: true })
    .click();
  await page.getByRole("option", { name: "Cursor", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Assigned model", exact: true })
    .click();
  if (cursorModels.length)
    await expect(
      page.getByRole("option", { name: cursorModels[0].label, exact: true }),
    ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".work-detail")).toBeVisible();
  assert.equal(await page.locator("select:visible").count(), 0);
  await page
    .getByRole("button", { name: "Close work item", exact: true })
    .click();
  data = await page.evaluate(() => window.memcode.load());
  const saved = data.state.tasks.find(
    (t) => t.title === "Smoke check · saved story",
  );
  assert.equal(saved.assignment, "manual");
  assert.equal(saved.harness, "cursor");
  assert.ok(saved.epicId);
  assert.equal(saved.run.state, "idle");
  const blocked = data.state.tasks.find(
    (t) => t.sourceKey === "integration" && t.projectId === "memcode-dogfood",
  );
  assert.match(
    await page.evaluate(async (id) => {
      try {
        await window.memcode.startWorker(id);
        return "unexpected launch";
      } catch (e) {
        return e.message;
      }
    }, blocked.id),
    /prerequisite/,
  );

  await page.evaluate(() => window.memcode.selectProject("example"));
  await page.locator(".nav-item").filter({ hasText: "Workspace" }).click();
  await expect(page.locator(".work-card")).toHaveCount(8);
  await shot(page, "01-workspace.png");
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await shot(page, "02-list.png");
  await page.getByRole("button", { name: "Board view", exact: true }).click();
  await page
    .getByRole("button", { name: "MC-013: Shape the worker workspace" })
    .click();
  await shot(page, "03-conversation.png");
  await page
    .getByRole("combobox", { name: "Assigned harness", exact: true })
    .click();
  await shot(page, "12-assignment-selector.png");
  await page.keyboard.press("Escape");
  await expect(page.locator(".work-detail")).toBeVisible();
  await page.getByRole("button", { name: "Runbook", exact: true }).click();
  await shot(page, "04-runbook.png");
  await page
    .getByRole("button", { name: "Close work item", exact: true })
    .click();
  await page.locator(".nav-item").filter({ hasText: "Workers" }).click();
  await expect(page.locator(".harness-card")).toHaveCount(3);
  const logos = await page
    .locator(".harness-card .harness-mark img")
    .evaluateAll((images) =>
      images.map((image) => ({
        src: image.getAttribute("src"),
        loaded: image.complete && image.naturalWidth > 0,
        width: image.getBoundingClientRect().width,
      })),
    );
  assert.ok(logos.every((image) => image.loaded && image.width <= 25));
  await shot(page, "13-connected-harnesses.png");
  await page.locator(".nav-item").filter({ hasText: "Artifacts" }).click();
  await shot(page, "05-artifacts.png");
  await page.getByRole("button", { name: /workspace-preview.html/ }).click();
  await page
    .locator(".detail-tabs button")
    .filter({ hasText: "Artifacts" })
    .click();
  await page
    .getByRole("button", { name: /workspace-preview.html/ })
    .last()
    .click();
  await expect
    .poll(() =>
      desktop.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].contentView.children.length,
      ),
    )
    .toBeGreaterThan(0);
  const guest = await desktop.evaluate(async ({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find(
      (view) => view.webContents,
    );
    await new Promise((resolve) => {
      if (!view.webContents.isLoading()) resolve();
      else view.webContents.once("did-finish-load", resolve);
    });
    return {
      bridge: await view.webContents.executeJavaScript("typeof window.memcode"),
      node: await view.webContents.executeJavaScript("typeof require"),
      image: (await view.webContents.capturePage()).toPNG().toString("base64"),
    };
  });
  assert.equal(guest.bridge, "undefined");
  assert.equal(guest.node, "undefined");
  await writeFile(
    join(out, "07-browser-content.png"),
    Buffer.from(guest.image, "base64"),
  );
  await shot(page, "06-browser-shell.png");
  await page
    .getByRole("combobox", { name: "Assigned harness", exact: true })
    .click();
  await expect
    .poll(() =>
      desktop.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].contentView.children.length,
      ),
    )
    .toBe(0);
  await page.keyboard.press("Escape");
  await expect
    .poll(() =>
      desktop.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].contentView.children.length,
      ),
    )
    .toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "Close work item", exact: true })
    .click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await shot(page, "08-settings.png");
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.memcode.selectProject("memcode-dogfood"));
  await page.locator(".nav-item").filter({ hasText: "Roadmap" }).click();
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1180, 820),
  );
  await shot(page, "14-roadmap-compact.png");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await desktop.close();
  desktop = undefined;
  // An explicit UI fixture in this smoke test's private profile only.
  const fixture = JSON.parse(
    await readFile(join(profile, "workspace.json"), "utf8"),
  );
  const other = fixture.tasks.find(
    (task) =>
      task.projectId === "memcode-dogfood" &&
      task.sourceKey === "route-regressions",
  );
  fixture.fleetConflicts.push({
    id: "smoke-decision",
    projectId: "memcode-dogfood",
    epicId: saved.epicId,
    branch: "epic/ui-test-fixture",
    taskIds: [saved.id, other.id],
    agentIds: [`memcode:${saved.id}`, `memcode:${other.id}`],
    scope: ["file::tests/example.ts"],
    severity: "C",
    source: "runtime",
    summary:
      "Test fixture: two stories propose conflicting changes to one contract.",
    status: "open",
    createdAt: new Date().toISOString(),
  });
  await writeFile(
    join(profile, "workspace.json"),
    JSON.stringify(fixture, null, 2),
  );
  page = await launch();
  data = await page.evaluate(() => window.memcode.load());
  assert.ok(
    data.state.tasks.some((t) => t.id === saved.id && t.harness === "cursor"),
  );
  assert.equal(
    data.state.epics.filter((e) => e.projectId === "memcode-dogfood").length,
    10,
  );
  await page.locator(".nav-item").filter({ hasText: "Decisions" }).click();
  await expect(page.locator(".decision-card.open")).toHaveCount(1);
  await shot(page, "16-decision-test-fixture.png");
  await page
    .getByLabel("Resolution for smoke-decision", { exact: true })
    .fill(
      "Preserve the first contract. The other story must re-read it before continuing.",
    );
  await page
    .getByRole("combobox", {
      name: "Who continues for smoke-decision",
      exact: true,
    })
    .click();
  await page
    .getByRole("option", { name: new RegExp(saved.identifier + " proceeds") })
    .click();
  await page
    .getByRole("button", { name: "Record decision", exact: true })
    .click();
  await expect(page.locator(".decision-card.open")).toHaveCount(0);
  data = await page.evaluate(() => window.memcode.load());
  assert.equal(data.state.fleetConflicts[0].status, "resolved");
  assert.equal(data.state.fleetConflicts[0].winnerTaskId, saved.id);
  assert.equal(
    data.state.tasks.some((task) =>
      ["preparing", "running"].includes(task.run.state),
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        result: "passed",
        epics: 9,
        bankedStories: 38,
        harnesses: data.runtime.harnesses.map((h) => ({
          name: h.name,
          models: h.models.length,
        })),
        verified: [
          "epic/story persistence",
          "automatic and manual assignment",
          "custom keyboard menus",
          "official SVG loading",
          "private browser without preload/Node",
          "browser overlay hiding",
          "prerequisite launch gate",
          "no automatic workers",
          "compact desktop layout",
          "human Fleet decision persisted without auto-resume",
        ],
        screenshots: out,
        profile,
      },
      null,
      2,
    ),
  );
} finally {
  await desktop?.close();
  await server?.close();
}
