import { execFileSync, spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { nativeBuildEnv } from "./tauri-env.mjs";
import {
  macReleasePolicy,
  prepareMacSigning,
  verifyMacRelease,
} from "./macos-release-trust.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
for (const file of [
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "third_party/inventory.json",
])
  await access(file);
const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.license !== "PolyForm-Noncommercial-1.0.0")
  throw Error("The desktop license is missing");
if (!process.env.TAURI_SIGNING_PRIVATE_KEY)
  throw Error(
    "An updater signing key is required to package a release. Keep it outside this repository.",
  );
if (process.platform === "darwin") macReleasePolicy();
execFileSync(process.execPath, ["scripts/verify-third-party-notices.mjs"], {
  stdio: "inherit",
  windowsHide: true,
});
execFileSync(process.execPath, ["scripts/prepare-desktop-runtime.mjs"], {
  stdio: "inherit",
  windowsHide: true,
});
execFileSync(process.execPath, ["--import", "tsx", "scripts/prepare-memtrace-engine.mjs"], {
  stdio: "inherit",
  windowsHide: true,
});
execFileSync(process.execPath, ["scripts/build.mjs"], {
  stdio: "inherit",
  windowsHide: true,
});
const target =
  process.platform === "win32"
    ? "nsis"
    : process.platform === "darwin"
      ? "app,dmg"
      : "deb,appimage";
const baseConfig = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
const config = JSON.stringify({
  bundle: {
    active: true,
    createUpdaterArtifacts: true,
    // Keep development/no-bundle builds independent of installer downloads.
    resources: {
      ...baseConfig.bundle.resources,
      "../dist-memtrace-engine/": "memtrace-engine/",
    },
  },
});
const cli = fileURLToPath(
  new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url),
);
let signing;
try {
  signing =
    process.platform === "darwin" ? await prepareMacSigning(root) : undefined;
  const buildEnv = nativeBuildEnv(signing?.env);
  // nativeBuildEnv inherits process.env. Do not reintroduce certificate material
  // deliberately removed after import, or credentials in an ad-hoc candidate.
  if (signing)
    for (const key of Object.keys(process.env))
      if (key.startsWith("APPLE_") && !(key in signing.env))
        delete buildEnv[key];
  const code = await new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [cli, "build", "--bundles", target, "--config", config],
      {
        cwd: root,
        env: buildEnv,
        stdio: "inherit",
        windowsHide: true,
      },
    );
    child.once("error", reject);
    child.once("exit", (value) => done(value ?? 1));
  });
  if (code !== 0) throw Error("Native desktop packaging failed.");
  if (signing) await verifyMacRelease(root, signing);
} finally {
  await signing?.cleanup();
}
