import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { nativeBuildEnv } from "./tauri-env.mjs";

const server = await createServer();
await server.listen();
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
