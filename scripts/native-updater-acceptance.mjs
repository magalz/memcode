// Exercise the actual packaged main webview -> Tauri ACL -> updater commands.
// Private QA builds must stop at the exact development guard: no download,
// installation, account access, endpoint override or signature bypass is used.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const argument = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
if (process.argv.includes("--help")) {
  console.log("node scripts/native-updater-acceptance.mjs [--packaged-app <MemCode.app|memcode.exe>] [--version <version>] [--output <report.json>]");
  process.exit(0);
}
assert.ok(["darwin", "win32"].includes(process.platform), "This acceptance requires native macOS or Windows");
const expectedVersion = argument("--version") ?? JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
const app = resolve(argument("--packaged-app") ?? join(root, process.platform === "darwin"
  ? "src-tauri/target/release/bundle/macos/MemCode.app"
  : "src-tauri/target/release/memcode.exe"));
const executable = process.platform === "darwin" ? join(app, "Contents/MacOS/memcode") : app;
const output = resolve(argument("--output") ?? join(root, `release/native-updater-acl-${process.platform}.json`));
const profile = await mkdtemp(join(tmpdir(), "memcode-updater-acl-"));
if (process.platform === "darwin") {
  await chmod(profile, 0o700);
} else {
  const sid = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {encoding:"utf8", windowsHide:true}).match(/S-1-5-[0-9-]+/)?.[0];
  assert.ok(sid, "A private Windows QA profile requires the current user SID");
  execFileSync("icacls.exe", [profile, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], {stdio:"pipe", windowsHide:true});
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:MEMCODE_|MEMTRACE_|MEMDB_|MEMCORTEX_|CORTEX_|NODE_|APPLE_|ANTHROPIC_|OPENAI_|CLAUDE_|CURSOR_|TAURI_SIGNING_|WEBVIEW2_)/i.test(key) && !/^path$/i.test(key)));
Object.assign(env, {
  PATH: process.platform === "darwin" ? "/usr/bin:/bin" : [join(process.env.SystemRoot ?? "C:/Windows", "System32"), process.env.SystemRoot ?? "C:/Windows"].join(";"),
  MEMCODE_DATA_DIR: profile,
  MEMCODE_NATIVE_TEST_PROFILE: "1",
  MEMCODE_UPDATER_ACL_TEST: "1",
  MEMCODE_TRACE_TRANSPORT: "1",
});
const report = {
  passed: false,
  platform: process.platform,
  architecture: process.arch,
  expectedVersion,
  freshPrivateProfile: true,
  normalProfilesTouched: false,
  accountUsed: false,
  actualPackagedNativeProcess: false,
  actualRendererToNativeIpc: false,
  globalNodeRemovedFromPath: true,
  realUpdateDownloadTested: false,
  installationTested: false,
  method: "Main native webview invokes updater commands with a valid IPC channel; exact development guard proves ACL dispatch before network or mutation.",
  stages: [],
};
const prefix = "[memcode-transport-rpc] ";
const stages = new Set();
let pendingLines = "", child, closed, launchFailed = false;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const collect = (chunk) => {
  pendingLines = (pendingLines + chunk.toString()).slice(-64000);
  const lines = pendingLines.split(/\r?\n/);
  pendingLines = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.startsWith(prefix)) continue;
    try {
      const call = JSON.parse(line.slice(prefix.length));
      if (call.stage === "rpc-start" && /^updater-acl:[a-zA-Z0-9.:-]+$/.test(call.method)) {
        stages.add(call.method.slice("updater-acl:".length));
      }
    } catch { /* Ignore partial or unrelated bounded diagnostics. */ }
  }
};
try {
  await access(executable);
  report.executableSha256 = createHash("sha256").update(await readFile(executable)).digest("hex");
  child = spawn(executable, [], {cwd:dirname(executable), env, stdio:["ignore", "pipe", "pipe"], windowsHide:true});
  closed = new Promise((done) => {
    child.once("exit", done);
    child.once("error", () => { launchFailed = true; done(); });
  });
  // Separate buffers prevent simultaneous stdout/stderr fragments mixing.
  child.stderr.on("data", collect);
  child.stdout.resume();
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (launchFailed) throw Error("native-process-start-failed");
    if (child.exitCode !== null) throw Error("native-process-exited-before-proof");
    if ([...stages].some((stage) => /:(?:acl-denied|unexpected(?:-error|-success)?)$/.test(stage))) {
      throw Error("native-updater-ipc-probe-rejected");
    }
    if (stages.has("finished")) break;
    await pause(100);
  }
  assert.ok(stages.has("finished"), "native-updater-ipc-proof-timeout");
  assert.ok(stages.has(`version:${expectedVersion}`), "packaged-version-does-not-match-candidate");
  for (const command of ["info", "check", "download", "install"]) {
    assert.ok(stages.has(`${command}:pass`), `native-updater-${command}-proof-missing`);
  }
  Object.assign(report, {
    passed: true,
    currentVersion: expectedVersion,
    actualPackagedNativeProcess: true,
    actualRendererToNativeIpc: true,
    earlyDevelopmentGuardVerified: true,
    downloadCommandAllowed: true,
    installCommandAllowed: true,
  });
} catch (error) {
  // Only fixed categories/assertions above are reported, never raw native logs.
  report.failure = error.code === "ENOENT" ? "packaged-executable-missing" : error.message;
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && !launchFailed) {
    child.kill("SIGTERM");
    await Promise.race([closed, pause(5000)]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await Promise.race([closed, pause(5000)]);
    }
  }
  report.stages = [...stages];
  report.checkedAt = new Date().toISOString();
  await mkdir(dirname(output), {recursive:true});
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
