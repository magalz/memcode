import { build } from "esbuild";
await build({
  entryPoints: ["runtime/service.ts"],
  outfile: "dist-runtime/service.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
});
console.log("MemCode local runtime bundled.");
await import("./build-context.mjs");
