import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nativeBuildEnv } from "./tauri-env.mjs";
const cli = new URL(
  "../node_modules/@tauri-apps/cli/tauri.js",
  import.meta.url,
);
const args = [
  "build",
  "--no-bundle",
  ...(process.env.MEMCODE_NATIVE_PROFILE === "debug" ? ["--debug"] : []),
];
const child = spawn(process.execPath, [fileURLToPath(cli), ...args], {
  env: nativeBuildEnv(),
  stdio: "inherit",
  windowsHide: true,
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
