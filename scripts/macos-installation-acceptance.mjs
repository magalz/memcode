// Exercise the actual native install guard, including its Core Foundation FFI,
// from our own generated app and read-only disk image. No account or UI opens.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

assert.equal(process.platform, "darwin", "This fixture requires native macOS.");
const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const profile = await mkdtemp(join(tmpdir(), "memcode-install-guard-"));
await chmod(profile, 0o700);
const project = join(profile, "probe-project");
const source = join(profile, "source");
const home = join(profile, "home");
const app = join(source, "MemCode.app");
const program = "memcode-installation-probe";
const image = join(profile, "fixture.dmg");
const volume = "MemCodeInstallFixture-" + process.pid + "-" + Date.now();
const mount = join("/Volumes", volume);
const output = join(root, "release", "macos-installation-guard.json");
let mountAttempted = false;
let mounted = false;
const report = {
  passed: false,
  sourceCommit: process.env.GITHUB_SHA ?? null,
  platform: process.platform,
  accountUsed: false,
  normalApplicationsModified: false,
  normalProfilesTouched: false,
  applicationCopied: "generated test probe only",
  nativeFinderActionsInvoked: false,
  offlineDependencyBuild: true,
};
const run = (file, args, options = {}) =>
  execute(file, args, { timeout: 60000, maxBuffer: 64000, ...options });
const observe = async (file) =>
  JSON.parse(
    (
      await run(file, [], {
        env: { HOME: home, PATH: "/usr/bin:/bin" },
        timeout: 15000,
      })
    ).stdout,
  );

try {
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(
    join(project, "Cargo.toml"),
    `[package]\nname = "${program}"\nversion = "0.0.0"\nedition = "2021"\n` +
      `[dependencies]\nserde = { version = "1", features = ["derive"] }\n` +
      `serde_json = "1"\ncore-foundation = "=0.10.1"\n`,
  );
  await writeFile(
    join(project, "src", "main.rs"),
    `#[path = ${JSON.stringify(join(root, "src-tauri", "src", "install_location.rs"))}]\n` +
      `mod install_location;\n` +
      `fn main() { println!("{}", serde_json::to_string(&install_location::status()).unwrap()); }\n`,
  );
  await run(
    "cargo",
    [
      "build",
      "--offline",
      "--manifest-path",
      join(project, "Cargo.toml"),
      "--target-dir",
      join(project, "target"),
    ],
    { timeout: 120000, env: { ...process.env, CARGO_BUILD_JOBS: "2" } },
  );
  const binary = join(project, "target", "debug", program);
  report.development = await observe(binary);
  assert.deepEqual(report.development, {
    state: "development",
    needsInstall: false,
    canUpdate: false,
  });

  const executable = join(app, "Contents", "MacOS", program);
  await mkdir(dirname(executable), { recursive: true });
  await copyFile(binary, executable);
  await chmod(executable, 0o755);
  await writeFile(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict>` +
      `<key>CFBundleIdentifier</key><string>dev.memcode.installation-probe</string>` +
      `<key>CFBundleExecutable</key><string>${program}</string></dict></plist>`,
  );
  report.writableApp = await observe(executable);
  assert.deepEqual(report.writableApp, {
    state: "portable",
    needsInstall: false,
    canUpdate: true,
  });
  await run("/usr/bin/hdiutil", [
    "create",
    "-srcfolder",
    source,
    "-format",
    "UDRO",
    "-volname",
    volume,
    "-o",
    image,
  ]);
  mountAttempted = true;
  await run("/usr/bin/hdiutil", [
    "attach",
    image,
    "-readonly",
    "-nobrowse",
    "-mountpoint",
    mount,
  ]);
  mounted = true;
  report.readOnlyDiskImage = await observe(
    join(mount, "MemCode.app", "Contents", "MacOS", program),
  );
  assert.deepEqual(report.readOnlyDiskImage, {
    state: "disk-image",
    needsInstall: true,
    canUpdate: false,
  });
  report.nativeCoreFoundationReadOnlyPropertyVerified = true;
  report.passed = true;
} catch (error) {
  report.failure = String(error.message).slice(0, 700);
  process.exitCode = 1;
} finally {
  if (mountAttempted) {
    try {
      await run("/usr/bin/hdiutil", ["detach", mount], { timeout: 30000 });
      mounted = false;
      mountAttempted = false;
    } catch {
      report.passed = false;
      report.failure = "Could not detach the isolated installation test image.";
      process.exitCode = 1;
    }
  }
  report.checkedAt = new Date().toISOString();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  assert.ok(
    resolve(profile).startsWith(resolve(tmpdir()) + "/memcode-install-guard-"),
  );
  // Never traverse a mounted filesystem or delete its backing image before detach.
  if (!mounted && !mountAttempted)
    await rm(profile, { recursive: true, force: true });
  console.log(JSON.stringify(report));
}
