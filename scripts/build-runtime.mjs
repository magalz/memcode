import { build } from "esbuild";
await build({
  entryPoints: ["runtime/service.ts"],
  outfile: "dist-runtime/service.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  external: ["playwright-core"],
});
console.log("MemCode local runtime bundled.");
await build({
  entryPoints: ["runtime/team/relay.ts"],
  outfile: "dist-runtime/team-relay.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
});
console.log("MemCode private team relay bundled.");
await import("./build-context.mjs");
