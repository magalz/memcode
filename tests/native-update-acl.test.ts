import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

test("every renderer update command is registered and granted by the main-only native capability", async () => {
  const [frontend, native, entry, permissionSource, mainSource] =
    await Promise.all([
      read("src/updates.ts"),
      read("src-tauri/src/updates.rs"),
      read("src-tauri/src/main.rs"),
      read("src-tauri/permissions/rpc.toml"),
      read("src-tauri/capabilities/main.json"),
    ]);
  // These are the actual literal command names supplied to Tauri, rather than
  // another manually maintained list that could omit the same new command.
  const calls = new Set(
    [
      ...frontend.matchAll(
        /\binvoke(?:<[^>]+>)?\(\s*["'](app_update_\w+)["']/g,
      ),
    ].map((match) => match[1]),
  );
  assert.ok(calls.size > 0, "The test must inspect real update invocations.");
  const nativeCommands = [
    ...native.matchAll(
      /#\[tauri::command\]\s*pub\s+(?:async\s+)?fn\s+(app_update_\w+)/g,
    ),
  ].map((match) => match[1]);
  assert.deepEqual(
    [...calls].sort(),
    nativeCommands.sort(),
    "Renderer and native updater command surfaces drifted.",
  );
  const registered = new Set(
    [...entry.matchAll(/updates::(app_update_\w+)/g)].map((match) => match[1]),
  );
  for (const name of calls)
    assert.ok(
      registered.has(name),
      `${name} must be registered in the native invoke handler.`,
    );

  const updaterPermission = permissionSource
    .split(/^\[\[permission\]\]\s*$/m)
    .find((block) => /^identifier\s*=\s*"allow-app-updates"\s*$/m.test(block));
  assert.ok(
    updaterPermission,
    "The narrow application updater permission must exist.",
  );
  const allowedSource = updaterPermission.match(
    /commands\.allow\s*=\s*\[([\s\S]*?)\]/,
  )?.[1];
  assert.ok(
    allowedSource,
    "The updater permission must explicitly name its allowed commands.",
  );
  const allowed = new Set(
    [...allowedSource.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]),
  );
  for (const name of calls)
    assert.ok(
      allowed.has(name),
      `${name} is invoked by the renderer but is missing from allow-app-updates.`,
    );
  assert.deepEqual(
    [...allowed].sort(),
    [...calls].sort(),
    "The updater capability must not grant unrelated commands.",
  );

  const main = JSON.parse(mainSource);
  assert.ok(main.permissions.includes("allow-app-updates"));
  const directory = new URL("src-tauri/capabilities/", root);
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    const capability = JSON.parse(
      await read(join("src-tauri/capabilities", name)),
    );
    assert.ok(
      !capability.permissions.some(
        (permission: unknown) =>
          typeof permission === "string" && permission.startsWith("updater:"),
      ),
      "Renderer capabilities must not bypass main-only application update guards through the plugin API.",
    );
    if (!capability.permissions.includes("allow-app-updates")) continue;
    assert.deepEqual(
      capability.webviews,
      ["main"],
      "Only the main application webview may manage app updates.",
    );
    assert.equal(
      capability.remote,
      undefined,
      "Remote origins must not receive app update permissions.",
    );
    assert.equal(
      capability.windows,
      undefined,
      "A window-wide grant could include an untrusted child webview.",
    );
  }
});
