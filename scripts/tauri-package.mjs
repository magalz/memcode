import { execFileSync, spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { nativeBuildEnv } from "./tauri-env.mjs";

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
execFileSync(process.execPath, ["scripts/verify-third-party-notices.mjs"], {
  stdio: "inherit",
  windowsHide: true,
});
execFileSync(process.execPath, ["scripts/prepare-desktop-runtime.mjs"], {
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
const config = JSON.stringify({
  bundle: { active: true, createUpdaterArtifacts: true },
});
const cli = fileURLToPath(
  new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url),
);
const child = spawn(
  process.execPath,
  [cli, "build", "--bundles", target, "--config", config],
  { cwd: root, env: nativeBuildEnv(), stdio: "inherit", windowsHide: true },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
