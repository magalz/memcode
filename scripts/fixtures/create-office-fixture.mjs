import { spawnSync } from "node:child_process";
import { mkdir, symlink, copyFile, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const helperDirectory = dirname(fileURLToPath(import.meta.url));
// This helper is also copied to <lab>/tools for an explicit live-worker proof.
const root = resolve(
  helperDirectory,
  helperDirectory.endsWith("fixtures") ? "../.." : "..",
);
const provider = process.argv[2],
  format = { codex: "xlsx", claude: "docx", cursor: "pptx" }[provider];
if (!format) throw Error("Choose codex, claude or cursor.");
const verificationDirectory = join(root, "tmp", "verification-fixtures");
const outputDir = resolve(
  process.env.MEMCODE_ARTIFACT_DIR ?? verificationDirectory,
);
const workerPath = relative(join(root, ".memcode", "workers"), outputDir);
if (
  outputDir !== verificationDirectory &&
  (!workerPath ||
    workerPath.startsWith("..") ||
    resolve(workerPath) === workerPath)
)
  throw Error(
    "Choose tmp/verification-fixtures or this project's worker artifact directory.",
  );
const base = process.env.MEMCODE_DOCUMENT_RUNTIME;
const skill = process.env.MEMCODE_DOCUMENT_SKILL_DIR;
if (!base || !skill)
  throw Error(
    "Set MEMCODE_DOCUMENT_RUNTIME and MEMCODE_DOCUMENT_SKILL_DIR for your locally installed document tools. See docs/review-and-previews.md.",
  );
const node = process.env.MEMCODE_DOCUMENT_NODE ?? process.execPath,
  python = process.env.MEMCODE_DOCUMENT_PYTHON ?? "python",
  packages =
    process.env.MEMCODE_DOCUMENT_PACKAGES ?? join(base, "node", "node_modules");
const workspace = join(root, ".memcode", "office", provider),
  build = join(workspace, "build"),
  qa = join(workspace, "qa");
await mkdir(build, { recursive: true });
await mkdir(qa, { recursive: true });
await mkdir(outputDir, { recursive: true });
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
      PATH: [
        join(base, "bin/override"),
        join(base, "bin/fallback"),
        process.env.PATH,
      ]
        .filter(Boolean)
        .join(delimiter),
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
    join(helperDirectory, "office-document.py"),
    join(build, "document.py"),
  );
  run(python, [join(build, "document.py"), output]);
  run(python, [join(skill, "render_docx.py"), output, "--output_dir", qa]);
} else {
  await copyFile(
    join(helperDirectory, "office-builder.mjs"),
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
