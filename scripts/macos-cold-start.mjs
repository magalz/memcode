// Native Mac CI check. A transport handshake is evidence of JavaScript calling
// the actual native/Node bridge; it is not a claim of physical UI usability.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
assert.equal(process.platform, "darwin", "Native cold-start requires macOS");
const app = join(root, "src-tauri/target/release/bundle/macos/MemCode.app");
const profile = await mkdtemp(join(tmpdir(), "memcode-cold-start-"));
const output = join(root, "release/macos-cold-start.json");
await mkdir(join(root, "release"), { recursive: true });
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(?:MEMCODE_|MEMTRACE_|MEMDB_|MEMCORTEX_|CORTEX_|NODE_|APPLE_|ANTHROPIC_|OPENAI_|CLAUDE_|CURSOR_|TAURI_SIGNING_)/i.test(
        key,
      ),
  ),
);
Object.assign(env, {
  PATH: "/usr/bin:/bin",
  MEMCODE_DATA_DIR: profile,
  MEMCODE_NATIVE_TEST_PROFILE: "1",
  MEMCODE_TRACE_TRANSPORT: "1",
});
let diagnostics = "",
  child,
  closed,
  report = {
    passed: false,
    platform: "darwin",
    architecture: process.arch,
    freshProfile: true,
    accountUsed: false,
    modelProviderStarted: false,
    managedEngineStarted: false,
    authenticated: false,
    uiUsability: "not-established; physical Mac acceptance remains required",
  };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
try {
  child = spawn(join(app, "Contents/MacOS/memcode"), [], {
    cwd: app,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  closed = new Promise((done) => child.once("exit", done));
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-64000);
    });
  child.once("error", () => {});
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw Error("The packaged Mac app exited during cold start");
    const calls = diagnostics
      .split(/\r?\n/)
      .filter((line) => line.startsWith("[memcode-transport-rpc] "))
      .flatMap((line) => {
        try {
          return [JSON.parse(line.slice("[memcode-transport-rpc] ".length))];
        } catch {
          return [];
        }
      });
    const handshake = calls.find(
      (call) =>
        call.stage === "rpc-end" &&
        ["workspace:load", "beta:status"].includes(call.method),
    );
    if (handshake) {
      const pids = execFileSync("/usr/bin/pgrep", ["-P", String(child.pid)], {
        encoding: "utf8",
      })
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const commands = pids.map((pid) =>
        execFileSync("/bin/ps", ["-ww", "-p", pid, "-o", "command="], {
          encoding: "utf8",
        }).trim(),
      );
      const expected = join(app, "Contents/Resources/desktop-runtime/node");
      assert.ok(
        commands.some((command) => command.startsWith(expected + " ")),
        "The native app must use its bundled Node, with no global Node fallback",
      );
      report = {
        ...report,
        passed: true,
        nativeProcessStarted: true,
        bundledNodeObserved: true,
        rendererToRuntimeHandshake: handshake.method,
        noGlobalNodeFallback: true,
      };
      break;
    }
    await pause(500);
  }
  assert.equal(
    report.passed,
    true,
    "No renderer-to-runtime cold-start handshake within 60 seconds",
  );
  // Screen capture can be restricted on hosted runners. Retain an image when
  // available, without treating a successful screenshot as a visual test.
  const screenshot = join(root, "release/macos-cold-start.png");
  try {
    execFileSync("/usr/sbin/screencapture", ["-x", screenshot], {
      stdio: "pipe",
      timeout: 10000,
    });
    await access(screenshot);
    report.screenshotCaptured = true;
  } catch {
    report.screenshotCaptured = false;
  }
} catch (error) {
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([closed, pause(5000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  report.checkedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
