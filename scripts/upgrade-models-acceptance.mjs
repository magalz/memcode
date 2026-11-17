// Explicit release check. Installs real models in ONE private profile, then
// changes actual app resource roots and verifies two offline cached restarts.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
if (process.argv.includes("--help")) {
  console.log(
    "Real cross-resource model retention: --previous-resources <old Resources/payload> --resources <new Resources/payload> [--output report.json]. Installs real retrieval and speech models once in one private profile; runs current product RPC under old and new bundled Node/resources; repeats offline twice. No accounts, microphone, normal profiles, worker execution or historical old product code.",
  );
  process.exit(0);
}
assert.ok(
  arg("--previous-resources") && arg("--resources"),
  "Supply both old and new packaged resource roots.",
);
const previous = await realpath(resolve(arg("--previous-resources")));
const resources = await realpath(resolve(arg("--resources")));
assert.notEqual(
  previous,
  resources,
  "The resource roots must actually change.",
);
const output = resolve(
  arg("--output") ??
    join(root, "release", `upgrade-models-${process.platform}.json`),
);
await mkdir(dirname(output), { recursive: true });
const profile = await realpath(
  await mkdtemp(join(tmpdir(), "memcode-model-upgrade-")),
);
const home = join(profile, "home");
await mkdir(home, { recursive: true, mode: 0o700 });
const digest = (value) => createHash("sha256").update(value).digest("hex");
const manifest = JSON.parse(
  await readFile(join(root, "scripts/desktop-node.json"), "utf8"),
);
async function verifyResources(directory) {
  const provenance = JSON.parse(
    await readFile(join(directory, "desktop-runtime/provenance.json"), "utf8"),
  );
  assert.equal(provenance.platform, process.platform);
  assert.equal(provenance.arch, process.arch);
  assert.equal(provenance.version, manifest.version);
  assert.equal(
    provenance.archiveSha256,
    manifest.archives[`${process.platform}-${process.arch}`].sha256,
  );
  const node = join(
    directory,
    "desktop-runtime",
    process.platform === "win32" ? "node.exe" : "node",
  );
  assert.equal(digest(await readFile(node)), provenance.executableSha256);
  assert.equal(
    execFileSync(node, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim(),
    `v${manifest.version}`,
  );
  const runtime = JSON.parse(
    await readFile(
      join(directory, "retriever-runtime/provenance.json"),
      "utf8",
    ),
  );
  assert.equal(runtime.platform, process.platform);
  assert.equal(runtime.arch, process.arch);
  assert.ok(Array.isArray(runtime.files) && runtime.files.length);
  assert.equal(
    runtime.files.some((file) =>
      /^node_modules\/(?:sharp\/|@img\/sharp)/.test(file.name),
    ),
    false,
  );
  return {
    node,
    provenance,
    retrievalManifestSha256: digest(
      await readFile(join(directory, "retriever-runtime/provenance.json")),
    ),
  };
}
const oldRuntime = await verifyResources(previous),
  newRuntime = await verifyResources(resources);
const helper = join(profile, "upgrade-fixture.cjs");
await build({
  entryPoints: [join(root, "scripts/fixtures/upgrade-models-acceptance.ts")],
  outfile: helper,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["playwright-core"],
  logLevel: "silent",
});
// Explicit environment, never inherited credentials, API keys, user caches or PATH.
const env = {
  HOME: home,
  USERPROFILE: home,
  TMPDIR: profile,
  TMP: profile,
  TEMP: profile,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  HF_HUB_OFFLINE: "1",
  TRANSFORMERS_OFFLINE: "1",
  LANG: "en_US.UTF-8",
  MEMCODE_NATIVE_TEST_PROFILE: "1",
  PATH:
    process.platform === "win32"
      ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32;${process.env.SystemRoot ?? "C:\\Windows"}`
      : "/usr/bin:/bin",
};
if (process.platform === "win32") {
  env.SystemRoot = process.env.SystemRoot ?? "C:\\Windows";
  env.APPDATA = join(home, "AppData/Roaming");
  env.LOCALAPPDATA = join(home, "AppData/Local");
  await mkdir(env.APPDATA, { recursive: true });
  await mkdir(env.LOCALAPPDATA, { recursive: true });
}
function run(phase, directory, node) {
  return new Promise((done, reject) => {
    const child = spawn(node, [helper, directory, profile, phase], {
      cwd: profile,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
    let pending = "";
    child.stdout.on("data", (chunk) => {
      pending = (pending + chunk.toString()).slice(-8000);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("[memcode-upgrade-models] ")) continue;
        try {
          const value = JSON.parse(
            line.slice("[memcode-upgrade-models] ".length),
          );
          if (
            Object.keys(value).sort().join(",") === "elapsedMs,phase,stage" &&
            value.phase === phase &&
            /^[a-z-]{1,50}$/.test(value.stage) &&
            Number.isSafeInteger(value.elapsedMs)
          )
            console.log("[memcode-upgrade-models] " + JSON.stringify(value));
        } catch {
          /* Do not publish arbitrary third-party output. */
        }
      }
    });
    child.stderr.on("data", () => {});
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      done(code ?? 1);
    });
  });
}
const report = {
  passed: false,
  sourceCommit:
    process.env.GITHUB_SHA ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    }).trim(),
  platform: process.platform,
  architecture: process.arch,
  checkedAt: new Date().toISOString(),
  samePrivateProfileForAllPhases: true,
  resourceRootsChanged: true,
  currentProductRpcUsed: true,
  historicalOldProductCodeExecuted: false,
  physicalInstallerUiTested: false,
  accountUsed: false,
  normalProfilesTouched: false,
  microphoneCaptureTested: false,
  workerStarted: false,
  cloudInference: false,
  allSubprocessNetworkObserved: false,
  previousNodeSha256: oldRuntime.provenance.executableSha256,
  currentNodeSha256: newRuntime.provenance.executableSha256,
  previousRetrievalRuntimeManifestSha256: oldRuntime.retrievalManifestSha256,
  currentRetrievalRuntimeManifestSha256: newRuntime.retrievalManifestSha256,
};
try {
  for (const phase of ["cold", "upgraded", "restarted"]) {
    const old = phase === "cold",
      code = await run(
        phase,
        old ? previous : resources,
        old ? oldRuntime.node : newRuntime.node,
      );
    const observed = JSON.parse(
      await readFile(join(profile, `${phase}.json`), "utf8"),
    );
    report[phase] = observed;
    assert.equal(code, 0, `Real model ${phase} failed; inspect safe stage.`);
    assert.equal(observed.passed, true);
    assert.equal(observed.realSpeechTranscriptionPassed, true);
    assert.equal(observed.realRetrievalPlanAndRankPassed, true);
    if (!old) {
      assert.equal(observed.remoteRequests, 0);
      assert.equal(observed.settingsAndWorkspacePreserved, true);
      assert.equal(observed.identicalModelBytesAndReceipts, true);
    }
  }
  report.passed = true;
} catch (error) {
  report.failure =
    error instanceof assert.AssertionError
      ? "acceptance-assertion"
      : "acceptance-execution";
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      passed: report.passed,
      platform: report.platform,
      output,
    }),
  );
}
