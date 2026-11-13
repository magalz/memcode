import { createServer } from "vite";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import electron from "electron";

const server = await createServer();
await server.listen();
await build({
  entryPoints: ["electron/main.ts"],
  outfile: "dist-electron/main.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron", "@modelcontextprotocol/sdk/*"],
  sourcemap: true,
});
await build({
  entryPoints: ["electron/preload.ts"],
  outfile: "dist-electron/preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
});
const env = { ...process.env, MEMCODE_DEV_URL: "http://127.0.0.1:5197" };
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn(electron, ["."], {
  stdio: "inherit",
  env,
  windowsHide: true,
});
app.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => app.kill());
