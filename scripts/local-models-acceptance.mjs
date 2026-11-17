// Explicit native integration test. No account, microphone or normal profile is used.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
if (process.argv.includes("--help")) {
  console.log("Explicit real local-model acceptance: --resources <verified resources root> OR --packaged-app <Mac .app or Windows exe>; [--only all|speech|retrieval] [--output <report.json>]. Installs models in an isolated temporary profile, then repeats offline from cache. No account or microphone access.");
  process.exit(0);
}
const only = arg("--only") ?? "all";
assert.ok(["all", "speech", "retrieval"].includes(only));
const app = arg("--packaged-app") ? resolve(arg("--packaged-app")) : undefined;
assert.ok(app || arg("--resources"), "Supply reviewed staged resources or an actual packaged app.");
assert.ok(!(app && arg("--resources")), "Use one resource origin.");
const resources = app
  ? process.platform === "darwin" ? join(app, "Contents/Resources") : dirname(app)
  : resolve(arg("--resources"));
const origin = app ? "actual-packaged-app-resources" : "reviewed-staging-resources";
const output = resolve(arg("--output") ?? join(root, "release", `local-models-${process.platform}.json`));
await mkdir(dirname(output), { recursive: true });
const profile = await realpath(await mkdtemp(join(tmpdir(), "memcode-local-model-acceptance-")));
const home = join(profile, "home");
await mkdir(home, { recursive: true, mode: 0o700 });
const digest = (value) => createHash("sha256").update(value).digest("hex");
const manifest = JSON.parse(await readFile(join(root, "scripts/desktop-node.json"), "utf8"));
const provenance = JSON.parse(await readFile(join(resources, "desktop-runtime/provenance.json"), "utf8"));
assert.equal(provenance.platform, process.platform);
assert.equal(provenance.arch, process.arch);
assert.equal(provenance.version, manifest.version);
assert.equal(provenance.archiveSha256, manifest.archives[`${process.platform}-${process.arch}`].sha256);
const node = join(resources, "desktop-runtime", process.platform === "win32" ? "node.exe" : "node");
assert.equal(digest(await readFile(node)), provenance.executableSha256);
assert.equal(execFileSync(node, ["--version"], { encoding: "utf8", windowsHide: true }).trim(), `v${manifest.version}`);
const helper = join(profile, "fixture.cjs");
await build({ entryPoints: [join(root, "scripts/fixtures/local-models-acceptance.ts")], outfile: helper, bundle: true, platform: "node", format: "cjs", target: "node24", logLevel: "silent" });
// Construct an environment, rather than copying account/model-provider secrets.
const env = {
  HOME: home, USERPROFILE: home, TMPDIR: profile, TMP: profile, TEMP: profile,
  XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
  HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", LANG: "en_US.UTF-8",
  PATH: process.platform === "win32" ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32;${process.env.SystemRoot ?? "C:\\Windows"}` : "/usr/bin:/bin",
};
if (process.platform === "win32") {
  env.SystemRoot = process.env.SystemRoot ?? "C:\\Windows";
  env.APPDATA = join(home, "AppData/Roaming");
  env.LOCALAPPDATA = join(home, "AppData/Local");
  await mkdir(env.APPDATA, { recursive: true });
  await mkdir(env.LOCALAPPDATA, { recursive: true });
}
const run = (phase) => new Promise((done, reject) => {
  const child = spawn(node, [helper, resources, profile, phase, only], { cwd: profile, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGTERM"), 12 * 60_000);
  let pending = "";
  child.stdout.on("data", (chunk) => {
    pending = (pending + chunk.toString()).slice(-8_000);
    const lines = pending.split(/\r?\n/); pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("[memcode-local-models] ")) continue;
      try {
        const value = JSON.parse(line.slice("[memcode-local-models] ".length));
        if (Object.keys(value).sort().join(",") === "elapsedMs,phase,stage" && value.phase === phase && /^[a-z-]{1,50}$/.test(value.stage) && Number.isSafeInteger(value.elapsedMs))
          console.log("[memcode-local-models] " + JSON.stringify(value));
      } catch { /* Third-party output is not an acceptance result. */ }
    }
  });
  child.stderr.on("data", () => {});
  child.once("error", reject);
  child.once("close", (code) => { clearTimeout(timer); done(code ?? 1); });
});
const report = {
  passed: false, sourceCommit: process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim(),
  platform: process.platform, architecture: process.arch, components: only,
  resourceOrigin: origin, bundledNodeUsed: true, bundledNodeVersion: provenance.version,
  bundledNodeSha256: provenance.executableSha256, freshPrivateHome: true,
  normalProfilesTouched: false, accountUsed: false, microphoneCaptureTested: false,
  physicalInstallerUiTested: false, cloudInference: false, allDescendantCleanupVerified: false,
  checkedAt: new Date().toISOString(),
};
try {
  if (only !== "speech") {
    const runtime = JSON.parse(await readFile(join(resources, "retriever-runtime/provenance.json"), "utf8"));
    assert.ok(Array.isArray(runtime.files));
    assert.equal(runtime.files.some((file) => /^node_modules\/(?:sharp\/|@img\/sharp)/.test(file.name)), false, "Text retrieval must not ship unused Sharp/libvips native image libraries.");
    report.unusedNativeImagePayloadExcluded = true;
    if (process.platform === "darwin") {
      const configured = JSON.parse(await readFile(join(root, "src-tauri/tauri.conf.json"), "utf8")).bundle.macOS.minimumSystemVersion.split(".").map(Number);
      const minimums = [];
      for (const file of runtime.files.filter((file) => /^node_modules\/onnxruntime-node\/bin\/napi-v6\/darwin\/arm64\/[^/]+\.(?:node|dylib)$/.test(file.name))) {
        const bytes = await readFile(join(resources, "retriever-runtime", file.name));
        assert.equal(digest(bytes), file.sha256);
        assert.equal(bytes.subarray(0, 4).toString("hex"), "cffaedfe");
        assert.equal(bytes.readUInt32LE(4), 0x0100000c);
        let offset = 32, minimum;
        for (let i = 0; i < bytes.readUInt32LE(16); i++) {
          const command = bytes.readUInt32LE(offset), size = bytes.readUInt32LE(offset + 4);
          assert.ok(size >= 8 && offset + size <= bytes.length);
          if (command === 0x32 || command === 0x24) {
            const value = bytes.readUInt32LE(offset + (command === 0x32 ? 12 : 8));
            minimum = [value >>> 16, (value >>> 8) & 255, value & 255];
          }
          offset += size;
        }
        assert.ok(minimum, "Every native local inference binary must declare its macOS minimum.");
        const comparison = minimum.map((n, i) => n - (configured[i] ?? 0)).find((n) => n !== 0) ?? 0;
        assert.ok(comparison <= 0, "Local inference requires a newer macOS than the application declares.");
        minimums.push({ name: file.name, minimumMacOS: minimum.join("."), sha256: file.sha256 });
      }
      assert.ok(minimums.some((file) => file.name.endsWith(".node")) && minimums.some((file) => file.name.endsWith(".dylib")));
      report.localInferenceMacMinimums = minimums;
    }
  }
  if (app && process.platform === "darwin" && only !== "retrieval") {
    const plist = await readFile(join(app, "Contents/Info.plist"), "utf8");
    assert.match(plist, /<key>NSMicrophoneUsageDescription<\/key>\s*<string>[^<]+<\/string>/);
    const entitlement = execFileSync("/usr/bin/codesign", ["-d", "--entitlements", ":-", app], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.match(entitlement, /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\s*\/>/);
    report.macMicrophoneMetadataVerified = true;
  }
  for (const phase of ["cold", "cached"]) {
    const code = await run(phase);
    const phaseReport = JSON.parse(await readFile(join(profile, `${phase}.json`), "utf8"));
    report[phase] = phaseReport;
    assert.equal(code, 0, `Local model ${phase} process failed; inspect its safe stage.`);
    assert.equal(phaseReport.passed, true);
    assert.equal(phaseReport.bundledNodePathVerified, true);
    if (phase === "cached") assert.equal(phaseReport.remoteRequests, 0);
  }
  report.cachedRestartVerified = true;
  report.passed = true;
} catch (error) {
  report.failure = error instanceof assert.AssertionError ? "acceptance-assertion" : "acceptance-execution";
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, platform: report.platform, resourceOrigin: origin, components: only, output }));
}
