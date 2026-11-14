import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { nativeBinary, nativeEnv } from "./tauri-env.mjs";
const binary = nativeBinary();
if (!existsSync(binary))
  throw new Error(
    "Build the Tauri desktop app first with npm run build:native.",
  );
const child = spawn(binary, [], {
  env: nativeEnv({
    MEMCODE_APP_PATH: resolve("."),
    MEMCODE_SERVICE_PATH: resolve("dist-runtime/service.cjs"),
  }),
  stdio: process.env.MEMCODE_NATIVE_LOGS === "1" ? "inherit" : "ignore",
  detached: process.env.MEMCODE_NATIVE_LOGS !== "1",
  windowsHide: true,
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 0;
});
if (process.env.MEMCODE_NATIVE_LOGS !== "1") child.unref();
