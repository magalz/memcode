import { build } from "esbuild";
await build({
  entryPoints: ["runtime/context/cli.ts"],
  outfile: "dist-runtime/context-gateway.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
});
console.log("MemCode context gateway bundled.");
