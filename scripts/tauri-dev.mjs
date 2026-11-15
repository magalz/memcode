import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { nativeBuildEnv } from "./tauri-env.mjs";

// Prepare the runtime and isolated artifact viewers before opening the dev shell.
// Only the renderer hot-reloads; native/runtime restarts remain explicit so an
// edited file cannot silently terminate a coding worker.
await import("./build.mjs");
// Vite's production build sets NODE_ENV in this process; reset it before HMR.
process.env.NODE_ENV = "development";
const server = await createServer();
await server.listen();
console.log(
  "MemCode development: UI changes reload live. Runtime/Rust changes require a controlled restart after active workers finish.",
);
const child = spawn(
  process.execPath,
  [
    fileURLToPath(
      new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url),
    ),
    "dev",
    "--no-watch",
  ],
  { env: nativeBuildEnv(), stdio: "inherit", windowsHide: true },
);
child.on("error", async (error) => {
  console.error(error.message);
  await server.close();
  process.exitCode = 1;
});
child.on("exit", async (code) => {
  await server.close();
  process.exitCode = code ?? 0;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill());
