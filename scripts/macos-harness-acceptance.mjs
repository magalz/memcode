// Native Finder-PATH discovery acceptance. No normal provider account is used,
// no coding task starts, and no CLI installer or shell profile is executed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  commandIdentity,
  findCommand,
  findDesktopApp,
} from "../runtime/commands.ts";

assert.equal(process.platform, "darwin", "This fixture requires native macOS.");
const execute = promisify(execFile);
async function fileSha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
const root = resolve(import.meta.dirname, "..");
const argument = (name) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const profile = await mkdtemp(join(tmpdir(), "memcode-mac-harness-"));
await chmod(profile, 0o700);
const home = join(profile, "home"),
  apps = join(profile, "Applications");
await mkdir(home, { recursive: true });
const options = {
  platform: "darwin",
  home,
  environment: { PATH: "/usr/bin:/bin" },
  systemDirectories: [],
  applicationDirectories: [apps],
};
const report = {
  passed: false,
  sourceCommit: process.env.GITHUB_SHA ?? null,
  platform: process.platform,
  architecture: process.arch,
  actualMacProcess: true,
  freshPrivateHome: true,
  bareGuiPath: true,
  normalUserAppsModified: false,
  normalProfilesTouched: false,
  accountUsed: false,
  codingWorkersStarted: false,
  providerInferenceRequested: false,
  cliInstallCommandsExecuted: false,
  shellProfilesExecuted: false,
  actualBundledCodexTestRequested: process.argv.includes("--verify-codex-app"),
};
const output = resolve(
  argument("--output") ?? join(root, "release", "macos-harness-discovery.json"),
);
let mounted = false;
const mount = join(profile, "official-app");
try {
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true });
  const cursorBinary = join(
    home,
    ".local",
    "share",
    "cursor-agent",
    "versions",
    "2026.11.13-fixture",
    "cursor-agent",
  );
  await mkdir(dirname(cursorBinary), { recursive: true });
  for (const path of [join(bin, "codex"), cursorBinary])
    await writeFile(
      path,
      "#!/usr/bin/env node\nprocess.stdout.write('memcode-synthetic-agent\\n');\n",
      { mode: 0o755 },
    );
  await symlink(cursorBinary, join(bin, "agent"));
  for (const name of ["codex", "cursor"]) {
    const command = await findCommand(name, "", options);
    assert.equal(
      command?.command,
      join(bin, name === "cursor" ? "agent" : name),
    );
    const result = await execute(
      command.command,
      [...command.prefix, "--version"],
      {
        env: { HOME: home, PATH: command.env?.PATH ?? "/usr/bin:/bin" },
        timeout: 10000,
      },
    );
    assert.equal(result.stdout.trim(), "memcode-synthetic-agent");
    if (name === "cursor")
      assert.equal(
        commandIdentity(command),
        "cursor-agent-install:" + join(home, ".local", "share", "cursor-agent"),
      );
  }
  report.existingUserBinCliLaunchesVerified = 2;
  report.shebangNodeWorksWithoutTerminalPath = true;
  report.knownCursorSymlinkVerified = true;
  const aliasedHome = join(profile, "home-alias");
  await symlink(home, aliasedHome, "dir");
  const aliasCommand = await findCommand("cursor", "", {
    ...options,
    home: aliasedHome,
  });
  assert.equal(
    aliasCommand?.command,
    join(aliasedHome, ".local", "bin", "agent"),
  );
  assert.equal(
    commandIdentity(aliasCommand),
    "cursor-agent-install:" +
      join(aliasedHome, ".local", "share", "cursor-agent"),
  );
  assert.equal(
    (
      await execute(aliasCommand.command, ["--version"], {
        env: { HOME: aliasedHome, PATH: aliasCommand.env.PATH },
        timeout: 10000,
      })
    ).stdout.trim(),
    "memcode-synthetic-agent",
  );
  report.canonicalHomeAliasDiscoveryAndLaunchVerified = true;
  const provider = join(
    home,
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  assert.equal(
    commandIdentity({
      command:
        "/Volumes/MemCode/MemCode.app/Contents/Resources/desktop-runtime/node",
      prefix: [provider],
    }),
    provider,
  );
  assert.equal(
    commandIdentity({
      command:
        "/Applications/MemCode.app/Contents/Resources/desktop-runtime/node",
      prefix: [provider],
    }),
    provider,
  );
  report.providerIdentityIndependentOfMemcodeLocation = true;
  const npmHome = join(profile, "npm-home");
  const npmBin = join(npmHome, ".npm-global", "bin");
  const npmProvider = join(
    npmHome,
    ".npm-global",
    "lib",
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  await mkdir(npmBin, { recursive: true });
  await mkdir(dirname(npmProvider), { recursive: true });
  await writeFile(
    npmProvider,
    "#!/usr/bin/env node\nprocess.stdout.write('memcode-synthetic-npm-agent\\n');\n",
    { mode: 0o755 },
  );
  const npmOptions = { ...options, home: npmHome };
  const scriptCommand = await findCommand("codex", "", npmOptions);
  assert.ok(scriptCommand);
  assert.equal(commandIdentity(scriptCommand), npmProvider);
  assert.equal(scriptCommand.command, process.execPath);
  assert.equal(
    (
      await execute(
        scriptCommand.command,
        [...scriptCommand.prefix, "--version"],
        {
          env: { HOME: npmHome, PATH: scriptCommand.env.PATH },
          timeout: 10000,
        },
      )
    ).stdout.trim(),
    "memcode-synthetic-npm-agent",
  );
  // Normal npm installs also create an executable symlink in their bin directory.
  await symlink(npmProvider, join(npmBin, "codex"));
  const linkedCommand = await findCommand("codex", "", npmOptions);
  assert.ok(linkedCommand);
  assert.equal(linkedCommand.command, join(npmBin, "codex"));
  assert.equal(
    (
      await execute(
        linkedCommand.command,
        [...linkedCommand.prefix, "--version"],
        {
          env: { HOME: npmHome, PATH: linkedCommand.env.PATH },
          timeout: 10000,
        },
      )
    ).stdout.trim(),
    "memcode-synthetic-npm-agent",
  );
  report.existingNpmScriptAndSymlinkLaunchesVerified = 2;
  const cursor = join(apps, "Cursor.app");
  await mkdir(join(cursor, "Contents"), { recursive: true });
  await writeFile(
    join(cursor, "Contents", "Info.plist"),
    '<?xml version="1.0"?><plist><dict/></plist>',
  );
  const emptyHome = join(profile, "empty-home");
  const emptyBin = join(emptyHome, ".local", "bin");
  await mkdir(emptyBin, { recursive: true });
  const unexpectedExecution = join(profile, "unexpected-agent-execution");
  await writeFile(
    join(emptyBin, "agent"),
    "#!/usr/bin/env node\nrequire('node:fs').writeFileSync(" +
      JSON.stringify(unexpectedExecution) +
      ", 'unexpected');\n",
    { mode: 0o755 },
  );
  await writeFile(join(emptyBin, "codex"), "not executable\n", { mode: 0o600 });
  const appOnly = { ...options, home: emptyHome };
  assert.equal(await findDesktopApp("cursor", appOnly), cursor);
  assert.equal(await findCommand("cursor", "", appOnly), null);
  assert.equal(await findCommand("codex", "", appOnly), null);
  await assert.rejects(readFile(unexpectedExecution), { code: "ENOENT" });
  report.unrelatedAgentRejectedWithoutExecution = true;
  report.nonExecutableCommandsRejected = true;
  report.editorPresenceDistinctFromAgentRuntime = true;

  if (report.actualBundledCodexTestRequested) {
    assert.equal(
      process.env.GITHUB_ACTIONS,
      "true",
      "Download/mount the official application only on a disposable CI runner.",
    );
    // This URL is the macOS download linked by official OpenAI app docs. It is
    // inspected for compatibility only; never copied into MemCode or artifacts.
    const url = "https://persistent.oaistatic.com/codex-app-prod/Codex.dmg";
    const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const maximum = 1_500_000_000;
    const declared = Number(response.headers.get("content-length"));
    assert.ok(
      Number.isSafeInteger(declared) && declared > 0 && declared <= maximum,
    );
    const dmg = join(profile, "official-Codex.dmg");
    let downloaded = 0;
    const hash = createHash("sha256");
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, _encoding, done) {
          downloaded += chunk.length;
          if (downloaded > maximum)
            return done(
              Error("Official app exceeded the bounded download size."),
            );
          hash.update(chunk);
          done(null, chunk);
        },
      }),
      createWriteStream(dmg, { mode: 0o600 }),
    );
    assert.equal(downloaded, declared);
    report.officialCodexDmg = {
      url,
      bytes: downloaded,
      sha256: hash.digest("hex"),
    };
    await mkdir(mount);
    await execute(
      "/usr/bin/hdiutil",
      ["attach", dmg, "-readonly", "-nobrowse", "-mountpoint", mount],
      { timeout: 60000, maxBuffer: 64000 },
    );
    mounted = true;
    const appOptions = { ...appOnly, applicationDirectories: [mount] };
    const command = await findCommand("codex", "", appOptions);
    if (!command) {
      // Only provider filenames, never raw logs, account files or user content.
      for (const name of ["Codex.app", "ChatGPT.app"]) {
        const resources = join(mount, name, "Contents", "Resources");
        const entries = await readdir(resources).catch(() => []);
        if (entries.length)
          report.officialAppCandidateFiles = entries
            .filter((name) => /codex|agent|runtime|bin|app/i.test(name))
            .slice(0, 30);
      }
    }
    assert.ok(
      command,
      "Official Mac app's supported agent binary was not detected.",
    );
    const app = await findDesktopApp("codex", appOptions);
    assert.ok(app && command.command.startsWith(app + "/Contents/Resources/"));
    report.actualBundledCodexEntrypoint = relative(app, command.command);
    const packageRoot = join(app, "Contents", "Resources", "codex-cli");
    if (command.command === join(packageRoot, "bin", "codex")) {
      const manifest = JSON.parse(
        await readFile(join(packageRoot, "codex-package.json"), "utf8"),
      );
      assert.equal(manifest.layoutVersion, 1);
      assert.equal(manifest.entrypoint, "bin/codex");
      assert.equal(manifest.variant, "codex");
      const nativeBinary = join(
        packageRoot,
        "CodexCLI.app",
        "Contents",
        "MacOS",
        "codex",
      );
      const nativeFile = await stat(nativeBinary);
      assert.ok(nativeFile.isFile() && nativeFile.size > 0);
      report.actualBundledCodexPackageVersion = manifest.version;
      report.actualBundledCodexPackageTarget = manifest.target;
      report.actualBundledCodexNativeBinary = relative(app, nativeBinary);
      report.actualBundledCodexNativeBinaryBytes = nativeFile.size;
      report.actualBundledCodexNativeBinarySha256 =
        await fileSha256(nativeBinary);
      report.actualBundledCodexEntrypointKind = "official-package-launcher";
      report.officialDeclaredEntrypointVerified = true;
    } else report.actualBundledCodexEntrypointKind = "legacy-native-cli";
    await execute(
      "/usr/bin/codesign",
      ["--verify", "--strict", "--deep", app],
      { timeout: 120000, maxBuffer: 64000 },
    );
    const nativeEnv = {
      HOME: emptyHome,
      CODEX_HOME: join(emptyHome, ".codex"),
      PATH: "/usr/bin:/bin",
    };
    const version = await execute(command.command, ["--version"], {
      env: nativeEnv,
      timeout: 15000,
      maxBuffer: 64000,
    });
    assert.match(version.stdout.trim(), /^codex-cli\s+\S+/);
    const help = await execute(command.command, ["app-server", "--help"], {
      env: nativeEnv,
      timeout: 15000,
      maxBuffer: 64000,
    });
    assert.match(help.stdout, /app-server/);
    report.actualBundledCodexCliVersion = version.stdout.trim();
    report.actualBundledCodexAppServerSupported = true;
    report.officialAppSignatureVerified = true;
    report.actualBundledCodexEntrypointSha256 = await fileSha256(
      command.command,
    );
  }
  report.passed = true;
} catch (error) {
  report.failure =
    error.code === "ETIMEDOUT"
      ? "native-discovery-operation-timed-out"
      : String(error.message).slice(0, 300);
  process.exitCode = 1;
} finally {
  if (mounted) {
    try {
      await execute("/usr/bin/hdiutil", ["detach", mount], {
        timeout: 30000,
        maxBuffer: 64000,
      });
      mounted = false;
    } catch {
      report.passed = false;
      report.failure = "Could not detach the isolated read-only test image.";
      process.exitCode = 1;
    }
  }
  await mkdir(dirname(output), { recursive: true });
  report.checkedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  // Only our newly created, fixed-prefix private fixture directory is removed.
  assert.ok(
    resolve(profile).startsWith(resolve(tmpdir()) + "/memcode-mac-harness-"),
  );
  if (!mounted) await rm(profile, { recursive: true, force: true });
  console.log(JSON.stringify(report));
}
