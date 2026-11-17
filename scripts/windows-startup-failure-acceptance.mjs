// Exercise a real native initialization failure without removing shared Windows
// components or changing a real profile. A file obstructs this test's WebView data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

assert.equal(process.platform, "win32");
const binary = resolve(process.argv[2] ?? "");
assert.ok(binary.endsWith(".exe"));
const root = await mkdtemp(join(tmpdir(), "memcode-startup-failure-"));
const profile = join(root, "profile");
await mkdir(profile);
await writeFile(
  join(profile, "webview"),
  "Synthetic obstruction: this is intentionally a file.\n",
);
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(MEMCODE_|MEMTRACE_|MEMDB_|NODE_OPTIONS$|NODE_PATH$)/i.test(key))
    delete env[key];
Object.assign(env, {
  MEMCODE_DATA_DIR: profile,
  MEMCODE_NATIVE_TEST_PROFILE: "1",
});
const child = spawn(binary, [], { env, windowsHide: true, stdio: "ignore" });
const timer = setTimeout(() => child.kill(), 30_000);
try {
  const code = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", done);
  });
  assert.equal(
    code,
    1,
    "A failed native initialization must return a clear failure exit code.",
  );
  const report = JSON.parse(
    await readFile(join(profile, "diagnostics/native-startup.json"), "utf8"),
  );
  assert.equal(report.product, "MemCode");
  assert.equal(report.stage, "native-window");
  assert.equal(report.uploaded, false);
  assert.ok(report.error.length > 0 && report.error.length <= 4096);
  assert.equal(report.bundledNodePresent, true);
  assert.equal(report.localRuntimePresent, true);
  assert.equal(
    await readFile(join(profile, "webview"), "utf8"),
    "Synthetic obstruction: this is intentionally a file.\n",
  );
  console.log(
    JSON.stringify({
      passed: true,
      nativeWindowInitializationFailed: true,
      failureReportedLocally: true,
      existingObstructingFilePreserved: true,
      normalProfilesTouched: false,
      report: join(profile, "diagnostics/native-startup.json"),
    }),
  );
} finally {
  clearTimeout(timer);
  child.kill();
}
