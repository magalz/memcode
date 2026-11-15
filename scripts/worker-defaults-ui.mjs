// Isolated native renderer QA. No real worker, model or production profile is used.
// Connection status is a clearly labelled renderer fixture; defaults and task
// changes use the actual runtime IPC and persistence implementation.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { createServer } from "node:net";
import { chromium, expect } from "@playwright/test";
import { initialState } from "../src/seed.ts";
import { nativeBinary, nativeEnv } from "./tauri-env.mjs";

await access(nativeBinary());
const profile = await mkdtemp(join(tmpdir(), "memcode-worker-defaults-"));
const out = resolve("../tmp/memcode-worker-defaults-qa");
await mkdir(out, { recursive: true });
const state = initialState();
state.onboarding = { version: 1, step: "welcome", dismissed: true };
const story = state.tasks[0];
story.title = "Worker defaults renderer fixture";
story.harness = "codex";
story.assignment = "manual";
story.permissionMode = null;
story.run = { state: "idle" };
state.workerConnections = Object.fromEntries(
  ["codex", "claude", "cursor"].map((harness) => [
    harness,
    {
      harness,
      runtimePath: process.execPath,
      approvedAt: new Date().toISOString(),
      auth: "local",
      scopeVersion: 1,
      accountLabel: "QA fixture only",
    },
  ]),
);
await writeFile(join(profile, "workspace.json"), JSON.stringify(state));
const listener = createServer();
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const port = listener.address().port;
assert.notEqual(port, 9329, "The production inspector is forbidden");
await new Promise((done) => listener.close(done));
const child = spawn(nativeBinary(), [], {
  cwd: resolve("."),
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: nativeEnv({
    MEMCODE_DATA_DIR: profile,
    MEMCODE_SERVICE_PATH: resolve("dist-runtime/service.cjs"),
    MEMCODE_APP_PATH: resolve("."),
    MEMCODE_NATIVE_TEST_PROFILE: "1",
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  }),
});
let page,
  browser,
  diagnostics = "",
  startupError,
  report;
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-12000);
  });
const exited = new Promise((done) => {
  child.once("exit", done);
  child.once("error", (error) => {
    startupError = error;
    diagnostics += String(error);
    done(null);
  });
});
const rpc = (method, input = null) =>
  page.evaluate(
    ({ method, input }) =>
      window.__TAURI_INTERNALS__.invoke("rpc", { method, input }),
    { method, input },
  );
async function choose(label, value) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: label, exact: true }),
  ).toContainText(value);
}
async function openWorkers() {
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /^Workers/ })
    .click();
  await expect(
    page.locator(
      '.worker-connection-card[data-harness="codex"] .worker-default-control',
    ),
  ).toBeVisible({ timeout: 20000 });
}
async function openStory() {
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /^Workspace/ })
    .click();
  await page.getByText(story.title, { exact: true }).first().click();
  await expect(
    page.getByRole("combobox", { name: "Worker permission mode", exact: true }),
  ).toBeVisible();
}
async function mode() {
  return page.evaluate(
    async (id) =>
      (await window.memcode.load()).state.tasks.find((task) => task.id === id)
        .permissionMode,
    story.id,
  );
}
try {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
    } catch {}
    await new Promise((done) => setTimeout(done, 200));
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const pageDeadline = Date.now() + 15000;
  while (!page && Date.now() < pageDeadline) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url().includes("tauri.localhost"));
    if (!page) await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(page, "Expected isolated native main webview");
  await page.waitForFunction(() => !!window.memcode);
  const loaded = await page.evaluate(() => window.memcode.load());
  assert.equal(
    resolve(loaded.runtime.dataPath).toLowerCase(),
    resolve(profile).toLowerCase(),
  );
  await page.evaluate(() => window.memcode.selectProject("example"));
  await page.addInitScript(() => {
    let api;
    Object.defineProperty(window, "memcode", {
      configurable: true,
      get: () => api,
      set(value) {
        const realStatus = value.workerConnectionStatus;
        const realSave = value.saveSettings;
        window.__qaAccountRefreshes = 0;
        window.__qaSettingsSaves = 0;
        value.accountStatus = async () => {
          window.__qaAccountRefreshes++;
          return {
            status: "unknown",
            label: "QA account fixture",
            detail: "Renderer-only account status; no sign-in is performed.",
            loginPending: false,
          };
        };
        value.saveSettings = async (...args) => {
          window.__qaSettingsSaves++;
          return realSave(...args);
        };
        value.workerConnectionStatus = async () =>
          (await realStatus()).map((status) => ({
            ...status,
            connected: status.installed && window.__qaDisconnected !== true,
            auth: "local",
            accountLabel: "Renderer QA fixture",
            note: "Renderer connection fixture. No worker or model is launched.",
          }));
        api = value;
      },
    });
  });
  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 25000 });
  await openWorkers();
  await expect(page.locator(".account-panel")).toHaveCount(0);
  const refresh = page.getByRole("button", {
    name: "Refresh worker connections",
    exact: true,
  });
  const refreshStyle = await refresh.evaluate((button) => ({
    height: button.getBoundingClientRect().height,
    gap: parseFloat(getComputedStyle(button).gap),
  }));
  assert.ok(
    refreshStyle.height >= 30 && refreshStyle.gap >= 6,
    "Workers refresh is a styled, spaced control",
  );
  await choose("Codex default permissions", "Smart auto");
  await choose("Cursor default permissions", "Full access");
  await page
    .getByRole("combobox", { name: "Cursor default permissions", exact: true })
    .click();
  await expect(
    page.getByRole("option", { name: "Smart auto", exact: true }),
  ).toHaveAttribute("data-disabled", "");
  await page.keyboard.press("Escape");
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.memcode.load()).state.settings.workerPermissionDefaults,
      ),
    )
    .toEqual({ codex: "auto", cursor: "full-access" });
  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible();
  await openWorkers();
  await expect(
    page.getByRole("combobox", {
      name: "Codex default permissions",
      exact: true,
    }),
  ).toContainText("Smart auto");
  await expect(
    page.getByRole("combobox", {
      name: "Cursor default permissions",
      exact: true,
    }),
  ).toContainText("Full access");
  await page.screenshot({
    path: join(out, "workers-defaults.png"),
    animations: "disabled",
  });
  await page
    .locator(".sidebar-footer")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await expect(page.locator(".settings-body .account-panel")).toBeVisible();
  const accountRefresh = page
    .locator(".settings-body .account-panel")
    .getByRole("button", { name: "Refresh", exact: true });
  await expect(accountRefresh).toHaveAttribute("type", "button");
  const previousRefreshes = await page.evaluate(
    () => window.__qaAccountRefreshes,
  );
  await accountRefresh.click();
  await expect
    .poll(() => page.evaluate(() => window.__qaAccountRefreshes))
    .toBeGreaterThan(previousRefreshes);
  await expect(page.locator(".settings-body")).toBeVisible();
  assert.equal(
    await page.evaluate(() => window.__qaSettingsSaves),
    0,
    "Refreshing the account must not submit workspace settings",
  );
  await page.locator(".modal").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.locator(".settings-body").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: join(out, "account-settings.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await openStory();
  await expect(
    page.getByRole("combobox", { name: "Worker permission mode", exact: true }),
  ).toContainText("Worker default");
  await expect(page.locator(".worker-permissions")).toContainText(
    "Codex default: Smart auto",
  );
  await choose("Worker permission mode", "Review");
  await expect.poll(mode).toBe("review");
  await page
    .getByRole("button", { name: "Worker defaults", exact: true })
    .click();
  await expect(page.locator(".work-detail")).toHaveCount(0);
  await choose("Codex default permissions", "Full access");
  await openStory();
  await expect(
    page.getByRole("combobox", { name: "Worker permission mode", exact: true }),
  ).toContainText("Review");
  await choose("Worker permission mode", "Worker default");
  await expect.poll(mode).toBeNull();
  await expect(page.locator(".worker-permissions")).toContainText(
    "Codex default: Full access",
  );
  await page.locator(".work-inspector").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: join(out, "story-inherited-default.png"),
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Back to workspace", exact: true })
    .click();
  await openWorkers();
  await page.evaluate(() => {
    window.__qaDisconnected = true;
  });
  await page
    .getByRole("button", { name: "Refresh worker connections", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Connect Codex", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".worker-default-control")).toHaveCount(3);
  const connect = page.getByRole("button", {
    name: "Connect Codex",
    exact: true,
  });
  await expect(connect).toBeEnabled();
  const connectStyle = await connect.evaluate((button) => {
    const style = getComputedStyle(button);
    return {
      height: button.getBoundingClientRect().height,
      gap: parseFloat(style.gap),
      padding: parseFloat(style.paddingLeft),
      border: parseFloat(style.borderTopWidth),
    };
  });
  assert.ok(
    connectStyle.height >= 32 &&
      connectStyle.gap >= 6 &&
      connectStyle.padding >= 10 &&
      connectStyle.border >= 1,
    "Disconnected Connect button uses the actual styled secondary button",
  );
  await page.screenshot({
    path: join(out, "workers-disconnected.png"),
    animations: "disabled",
  });
  await connect.click();
  const consent = page.locator(".connection-consent");
  await expect(consent).toBeVisible();
  await expect(consent.getByRole("checkbox")).not.toBeChecked();
  const approve = consent.getByRole("button", {
    name: "Approve & connect",
    exact: true,
  });
  await expect(approve).toBeDisabled();
  await expect(approve).toHaveClass(/button primary/);
  const approveStyle = await approve.evaluate((button) => ({
    height: button.getBoundingClientRect().height,
    background: getComputedStyle(button).backgroundColor,
  }));
  assert.ok(
    approveStyle.height >= 32 && approveStyle.background !== "rgba(0, 0, 0, 0)",
    "Consent button is visibly styled before any approval",
  );
  await page.screenshot({
    path: join(out, "connection-consent.png"),
    animations: "disabled",
  });
  await consent
    .getByRole("button", { name: "Close connection approval", exact: true })
    .click();
  const saved = JSON.parse(
    await readFile(join(profile, "workspace.json"), "utf8"),
  );
  assert.deepEqual(saved.settings.workerPermissionDefaults, {
    codex: "full-access",
    cursor: "full-access",
  });
  assert.equal(
    saved.tasks.find((task) => task.id === story.id).permissionMode,
    null,
  );
  assert.ok(
    saved.tasks.every(
      (task) =>
        !["preparing", "running", "stopping"].includes(task.run.state) ||
        task.example,
    ),
  );
  report = {
    result: "passed",
    profile,
    port,
    binary: nativeBinary(),
    scope:
      "Actual native runtime persistence; labelled renderer-only connected statuses; no model or worker launched",
    workers: "default selection and reload persistence",
    cursor: "unsupported automatic mode disabled",
    story:
      "inherits, explicit override survives default changes, reset restores inheritance",
    activePolicy: "covered by runtime unit test; no actual worker started",
    accountPlacement:
      "Settings only; Workers has no account panel; account Refresh does not submit or close settings",
    disconnected:
      "Default selectors remain available; Connect and consent action styled; no connection approval given",
  };
} catch (error) {
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  await writeFile(
    join(out, "failure.json"),
    JSON.stringify(
      { error: String(error), stack: error.stack, diagnostics, profile, port },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (page && !page.isClosed())
    await rpc("window:action", "close").catch(() => {});
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((done) => setTimeout(() => done(false), 25000).unref()),
  ]);
  if (!stopped) {
    child.kill();
    throw Error("Native defaults QA did not close gracefully. " + diagnostics);
  }
  await assert.rejects(access(join(profile, "runtime.lock")), {
    code: "ENOENT",
  });
}
assert.ok(basename(profile).startsWith("memcode-worker-defaults-"));
await writeFile(
  join(out, "results.json"),
  JSON.stringify({ ...report, gracefulShutdown: "passed" }, null, 2),
);
console.log(
  JSON.stringify({
    result: report.result,
    profile,
    port,
    out,
    gracefulShutdown: "passed",
  }),
);
