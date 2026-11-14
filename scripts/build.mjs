import { build as buildRenderer } from "vite";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { cp } from "node:fs/promises";

execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "--noEmit"],
  { stdio: "inherit" },
);
await buildRenderer();
await buildRenderer({
  configFile: false,
  root: resolve("artifact-viewer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve("dist-artifact-viewer"),
    emptyOutDir: true,
    target: "es2023",
  },
});
await import("./build-runtime.mjs");
await buildRenderer({
  configFile: false,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  root: resolve("artifact-viewer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve("dist-artifact-annotations"),
    emptyOutDir: true,
    target: "es2023",
    cssCodeSplit: false,
    lib: {
      entry: resolve("artifact-viewer/html-annotations.tsx"),
      formats: ["es"],
      fileName: () => "html-annotations.js",
      cssFileName: "html-annotations",
    },
  },
});
for (const directory of ["cmaps", "standard_fonts", "wasm", "iccs"])
  await cp(
    resolve("node_modules/pdfjs-dist", directory),
    resolve("dist-artifact-viewer/pdfjs", directory),
    { recursive: true },
  );
console.log("MemCode Tauri renderer and local runtime ready.");
