import { spawnSync } from "node:child_process";
import { mkdir, symlink, copyFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const provider = process.argv[2],
  format = { codex: "xlsx", claude: "docx", cursor: "pptx" }[provider];
if (!format) throw Error("Choose codex, claude or cursor.");
const outputDir = process.env.MEMCODE_ARTIFACT_DIR;
if (
  !outputDir ||
  !resolve(outputDir).startsWith(join(root, ".memcode", "workers"))
)
  throw Error("Run this helper from its MemCode worker.");
const base =
  "C:/Program Files/WindowsApps/OpenAI.CodexPrimaryRuntime.v26-1112-611-0_26.1112.611.0_x64__3k8sg7r9htsxt/dependencies";
const node = join(base, "node/bin/node.exe"),
  python = join(base, "python/python.exe"),
  packages = join(base, "node/node_modules");
const skills = "C:/Users/AlexT/.codex/plugins/cache/openai-primary-runtime";
const family = {
  xlsx: "spreadsheets",
  docx: "documents",
  pptx: "presentations",
}[format];
const skill = join(skills, family, "26.1112.11011/skills", family);
const workspace = join(root, ".memcode", "office", provider),
  build = join(workspace, "build"),
  qa = join(workspace, "qa");
await mkdir(build, { recursive: true });
await mkdir(qa, { recursive: true });
await symlink(
  packages,
  join(build, "node_modules"),
  process.platform === "win32" ? "junction" : "dir",
).catch((e) => {
  if (e.code !== "EEXIST") throw e;
});
const output = join(
  outputDir,
  provider +
    "-" +
    {
      codex: "mission-planner",
      claude: "creative-brief",
      cursor: "field-notes",
    }[provider] +
    "." +
    format,
);
if (await stat(output).catch(() => null))
  throw Error("Preserving the existing Office artifact.");
const run = (exe, args, cwd = workspace) => {
  const r = spawnSync(exe, args, {
    cwd,
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      RUNTIME_NODE_MODULES: packages,
      RUNTIME_NODE: node,
      RUNTIME_PYTHON: python,
      PATH:
        join(base, "bin/override") +
        ";" +
        join(base, "bin/fallback") +
        ";" +
        process.env.PATH,
    },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw Error("Office fixture command exited " + r.status);
};
const marker = join(workspace, "operation-started.json");
if (!(await stat(marker).catch(() => null))) {
  run(
    node,
    [
      "container_tools/mark_artifact_operation_started.mjs",
      "--operation-kind",
      "create",
      "--expected-output-count",
      "1",
      "--output-format",
      format,
    ],
    skill,
  );
  await writeFile(
    marker,
    JSON.stringify({ format, at: new Date().toISOString() }),
  );
}
if (format === "docx") {
  await copyFile(
    join(root, "tools", "office-document.py"),
    join(build, "document.py"),
  );
  run(python, [join(build, "document.py"), output]);
  run(python, [join(skill, "render_docx.py"), output, "--output_dir", qa]);
} else {
  await copyFile(
    join(root, "tools", "office-builder.mjs"),
    join(build, "builder.mjs"),
  );
  const built =
    format === "pptx"
      ? join(workspace, "output", "field-notes-" + Date.now() + ".pptx")
      : output;
  run(node, [join(build, "builder.mjs"), format, built, qa, python, skill]);
  if (built !== output) await copyFile(built, output);
}
console.log(JSON.stringify({ provider, format, output, qa }));
