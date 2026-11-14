import { build as buildRenderer } from "vite";
import { execFileSync } from "node:child_process";

execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "--noEmit"],
  { stdio: "inherit" },
);
await buildRenderer();
await import("./build-runtime.mjs");
console.log("MemCode Tauri renderer and local runtime ready.");
