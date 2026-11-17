// Run the actual NSIS lifecycle, not a 7-Zip extraction. All app activity uses
// a disposable profile. Refuse to replace any existing installation/shortcut.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

assert.equal(process.platform, "win32");
const repository = fileURLToPath(new URL("../", import.meta.url));
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const version = option("--version");
assert.match(version ?? "", /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/);
const installer = resolve(option("--installer") ?? "");
assert.ok(installer.endsWith(".exe") && (await stat(installer)).isFile());
const expectedHash = option("--sha256");
assert.match(expectedHash ?? "", /^[a-f0-9]{64}$/);
assert.equal(
  createHash("sha256")
    .update(await readFile(installer))
    .digest("hex"),
  expectedHash,
);
const base = resolve(
  option("--evidence") ??
    join(
      process.env.RUNNER_TEMP ?? process.env.LOCALAPPDATA,
      "MemCodeInstallerAcceptance",
      Date.now().toString(),
    ),
);
const install = join(base, "Installed MemCode — João");
const profile = join(base, "profile");
await mkdir(base, { recursive: true });
const ps = join(
  process.env.SystemRoot,
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
const inspect = () =>
  JSON.parse(
    execFileSync(
      ps,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(repository, "scripts/windows-installer-state.ps1"),
        "-InstallDirectory",
        install,
      ],
      { encoding: "utf8", windowsHide: true },
    ),
  );
const initial = inspect();
assert.equal(
  initial.registration,
  null,
  "Use a clean Windows user: a registered installation must never be replaced.",
);
assert.equal(
  initial.rememberedLocation,
  null,
  "A previous installer location exists; do not replace a real installation.",
);
assert.ok(
  initial.shortcuts.every((link) => !link.exists),
  "Existing shortcuts must never be replaced.",
);
assert.equal(initial.executablePresent, false);
const report = {
  version,
  installerSha256: expectedHash,
  startedAt: new Date().toISOString(),
  actualNsisInstallation: true,
  normalProfilesTouched: false,
  accountApprovalRequested: false,
  workersStarted: false,
  install,
  profile,
  checks: [],
  status: "running",
};
const save = () =>
  writeFile(
    join(base, "windows-installer-lifecycle.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
const check = async (name, details = {}) => {
  report.checks.push({ name, passed: true, ...details });
  await save();
  console.log(JSON.stringify({ passed: true, name }));
};
const run = (path, args, timeout = 120_000) =>
  new Promise((done, reject) => {
    // NSIS requires /D= and _?= LAST and unquoted, including a path containing
    // spaces. Node's default quoting makes NSIS silently ignore the destination.
    const child = spawn(path, args, {
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("The installer did not finish within its time limit."));
    }, timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? done() : reject(Error(`Installer exited with code ${code}`));
    });
  });
async function port() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const value = server.address().port;
  await new Promise((done) => server.close(done));
  return value;
}
async function launch() {
  const debugPort = await port(),
    env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^(MEMCODE_|MEMTRACE_|MEMDB_|CORTEX_|MEMCORTEX_|NODE_OPTIONS$|NODE_PATH$|OPENAI_|ANTHROPIC_|CLAUDE_|CURSOR_)/i.test(
        key,
      )
    )
      delete env[key];
    if (key.toLowerCase() === "path")
      env[key] = [
        join(process.env.SystemRoot, "System32"),
        process.env.SystemRoot,
      ].join(";");
  }
  Object.assign(env, {
    MEMCODE_DATA_DIR: profile,
    MEMCODE_NATIVE_TEST_PROFILE: "1",
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
  });
  const child = spawn(join(install, "memcode.exe"), [], {
    cwd: process.env.SystemRoot,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    browser;
  child.once("error", (error) => {
    output += error.message;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes) => {
      output = (output + bytes.toString()).slice(-8_000);
    });
  try {
    const deadline = Date.now() + 40_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw Error(
          `The installed app exited before opening: ${child.exitCode}. ${output}`,
        );
      try {
        if (
          (
            await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
              signal: AbortSignal.timeout(500),
            })
          ).ok
        ) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((done) => setTimeout(done, 200));
    }
    assert.ok(ready, "The installed native WebView must open.");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const page =
      browser
        .contexts()[0]
        .pages()
        .find((p) => /tauri(?:\.localhost|:)/.test(p.url())) ??
      browser.contexts()[0].pages()[0];
    assert.ok(page);
    await page.waitForFunction(() => !!window.__TAURI_INTERNALS__, {
      timeout: 15_000,
    });
    const call = async (method, input = null) => {
      let timer;
      try {
        return await Promise.race([
          page.evaluate(
            ({ method, input }) =>
              window.__TAURI_INTERNALS__.invoke("rpc", { method, input }),
            { method, input },
          ),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(Error(`Installed app call timed out: ${method}`)),
              30_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const loaded = await call("workspace:load");
    assert.equal(loaded.runtime.appVersion, version);
    assert.equal(
      resolve(loaded.runtime.dataPath).toLowerCase(),
      profile.toLowerCase(),
    );
    return {
      page,
      call,
      loaded,
      async close() {
        const exited = new Promise((done) => child.once("exit", done));
        await call("window:action", "close").catch(() => {});
        const timer = setTimeout(() => child.kill(), 10_000);
        await exited;
        clearTimeout(timer);
        await browser.close().catch(() => {});
        await writeFile(join(base, "native-startup-output.txt"), output);
      },
    };
  } catch (error) {
    await writeFile(join(base, "native-startup-output.txt"), output);
    try {
      const state = execFileSync(
        ps,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false; @{ identity=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name; session=$env:SESSIONNAME; processes=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('memcode.exe','msedgewebview2.exe','node.exe') } | Select-Object Name,ProcessId,ParentProcessId,SessionId,ExecutablePath); webviewEnvironment=@(Get-ChildItem Env: | Where-Object { $_.Name -like 'WEBVIEW2_*' } | Select-Object Name,Value); windows=@(Get-Process memcode,msedgewebview2 -ErrorAction SilentlyContinue | Select-Object Id,MainWindowTitle,Responding); events=@(Get-WinEvent -FilterHashtable @{LogName='Application';StartTime=(Get-Date).AddMinutes(-5)} -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'memcode.exe|msedgewebview2.exe' } | Select-Object -First 5 Id,ProviderName,Message) } | ConvertTo-Json -Depth 5",
        ],
        { encoding: "utf8", windowsHide: true, timeout: 15_000 },
      );
      await writeFile(join(base, "native-startup-processes.json"), state);
    } catch (inspectionError) {
      await writeFile(
        join(base, "native-inspection-error.txt"),
        inspectionError.message,
      );
    }
    child.kill();
    await browser?.close().catch(() => {});
    throw error;
  }
}
function registered() {
  const state = inspect();
  assert.equal(state.registration?.name, "MemCode");
  assert.equal(state.registration.version, version);
  assert.equal(
    state.registration.location.replaceAll('"', "").toLowerCase(),
    install.toLowerCase(),
  );
  assert.equal(
    state.registration.uninstall.replaceAll('"', "").toLowerCase(),
    join(install, "uninstall.exe").toLowerCase(),
  );
  assert.ok(state.executablePresent && state.uninstallerPresent);
  for (const link of state.shortcuts) {
    assert.equal(link.exists, true);
    assert.equal(
      resolve(link.target).toLowerCase(),
      join(install, "memcode.exe").toLowerCase(),
    );
  }
  return state;
}
async function uninstall() {
  const state = registered();
  await run(join(install, "uninstall.exe"), ["/S", `_?=${install}`]);
  const after = inspect();
  assert.equal(after.registration, null);
  assert.equal(after.executablePresent, false);
  assert.ok(after.shortcuts.every((link) => !link.exists));
  return state;
}
let app,
  installed = false;
try {
  await save();
  await run(installer, ["/S", `/D=${install}`]);
  installed = true;
  const state = registered();
  for (const file of [
    "desktop-runtime/node.exe",
    "runtime/service.cjs",
    "memtrace-engine/engine.zip",
    "memtrace-engine/memcode-engine.json",
    "retriever-runtime/node_modules/@huggingface/transformers/package.json",
  ])
    await stat(join(install, file));
  await check(
    "Actual silent installation registers the app and uninstaller and creates working Start menu/desktop shortcuts",
    { webviewVersion: state.webviewVersion },
  );
  app = await launch();
  await app.page.locator(".install-welcome").waitFor({ state: "visible" });
  assert.ok(app.loaded.state.projects.every((project) => project.example));
  await app.page.screenshot({ path: join(base, "installed-first-launch.png") });
  await check(
    "Installed app opens from another working directory without Node or Memtrace on PATH; no private backlog is present",
  );
  await app.page
    .getByRole("button", { name: "Let’s get started", exact: true })
    .click();
  await app.page.locator(".install-welcome").waitFor({ state: "hidden" });
  const projectId = app.loaded.state.activeProjectId;
  const task = await app.call("task:create", {
    projectId,
    title: "Installer retention acceptance",
    description: "Synthetic test only",
    harness: "codex",
    assignment: "auto",
    priority: "medium",
  });
  await app.call("settings:save", {
    ...app.loaded.state.settings,
    automaticUpdateDownloads: false,
  });
  await app.close();
  app = undefined;
  app = await launch();
  assert.ok(
    app.loaded.state.tasks.some(
      (item) => item.id === task.id && item.title === task.title,
    ),
  );
  assert.equal(app.loaded.state.settings.automaticUpdateDownloads, false);
  assert.equal(await app.page.locator(".install-welcome").count(), 0);
  await app.close();
  app = undefined;
  await check(
    "Real relaunch keeps saved work, settings and onboarding progress",
  );
  // Match the updater's real NSIS switches, exercising its actual install path.
  await run(installer, ["/S", "/UPDATE", `/D=${install}`]);
  registered();
  app = await launch();
  assert.ok(app.loaded.state.tasks.some((item) => item.id === task.id));
  assert.equal(app.loaded.state.settings.automaticUpdateDownloads, false);
  await app.close();
  app = undefined;
  await check(
    "Actual NSIS update mode keeps registration, shortcut targets, profile and saved work",
  );
  await uninstall();
  installed = false;
  assert.ok(
    (await readFile(join(profile, "workspace.json"), "utf8")).includes(task.id),
  );
  await check(
    "Actual uninstallation removes the program and both shortcuts, removes the Apps entry and retains the profile",
  );
  await run(installer, ["/S", `/D=${install}`]);
  installed = true;
  registered();
  app = await launch();
  assert.ok(app.loaded.state.tasks.some((item) => item.id === task.id));
  assert.equal(app.loaded.state.settings.automaticUpdateDownloads, false);
  await app.close();
  app = undefined;
  await check(
    "Reinstallation restores saved work and settings without a new account approval",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = error.message;
  throw error;
} finally {
  await app?.close().catch(() => {});
  if (installed)
    await uninstall().catch((error) => {
      report.cleanupFailure = error.message;
    });
  // The standard uninstaller intentionally remembers the install path. Remove
  // only this new test key, and only when its exact path still belongs to us.
  const afterCleanup = inspect();
  if (!afterCleanup.registration)
    execFileSync(
      ps,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$p=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\memtrace\\MemCode' -ErrorAction SilentlyContinue; if ($p -and $p.'(default)' -eq $env:MEMCODE_ACCEPTANCE_INSTALL) { Remove-Item -LiteralPath 'HKCU:\\Software\\memtrace\\MemCode' }",
      ],
      {
        env: { ...process.env, MEMCODE_ACCEPTANCE_INSTALL: install },
        windowsHide: true,
        stdio: "pipe",
      },
    );
  // _?= runs the uninstaller in place. Delete its one remaining known file;
  // never recursively delete a computed installation or profile directory.
  if (!afterCleanup.registration && !afterCleanup.executablePresent)
    await unlink(join(install, "uninstall.exe")).catch(() => {});
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify({
      status: report.status,
      checks: report.checks.length,
      evidence: join(base, "windows-installer-lifecycle.json"),
    }),
  );
}
