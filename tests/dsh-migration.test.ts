import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyDshMigration,
  diffDshDesktopModels,
  dryRunDshMigration,
} from "../runtime/dsh-migration";
import {
  hasInlineSecret,
  parseDshPatchYaml,
  stringifyDshPatchYaml,
} from "../runtime/dsh-yaml";
import { exists } from "../runtime/commands";

async function setupMigrationFixture(t: test.TestContext): Promise<{
  dshHome: string;
  env: NodeJS.ProcessEnv;
  desktopDir: string;
  targetDir: string;
}> {
  const dshHome = await mkdtemp(join(tmpdir(), "memcode-dsh-migrate-"));
  t.after(() => rm(dshHome, { recursive: true, force: true }));

  const desktopDir = join(dshHome, "profiles", "desktop");
  const targetDir = join(dshHome, "profiles", "custom-acp");
  await mkdir(join(desktopDir, "node_modules"), { recursive: true });
  await mkdir(targetDir, { recursive: true });

  await writeFile(
    targetDir + "/package.json",
    JSON.stringify(
      {
        name: "dsh-profile-custom-acp",
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"] } },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(targetDir, "cordis.patch.yml"),
    stringifyDshPatchYaml([
      { id: "ui-theme", config: { fontSize: 14 } },
      {
        id: "llm-pi-ai",
        name: "@deepseek-ai/dsh-llm-pi-ai",
        config: {
          providers: {
            partial: {
              displayName: "Partial",
              apiKeyEnv: "PARTIAL_KEY",
              models: [{ id: "m1", name: "m1" }],
            },
          },
        },
      },
    ]),
  );
  await writeFile(join(targetDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

  return { dshHome, env: { DSH_HOME: dshHome }, desktopDir, targetDir };
}

async function writePluginPkg(
  desktopDir: string,
  pkgName: string,
  opts: { hasLlmPeer?: boolean; hasRegisterAdapter?: boolean; main?: string },
): Promise<void> {
  const pkgDir = join(desktopDir, "node_modules", ...pkgName.split("/"));
  await mkdir(join(pkgDir, "lib"), { recursive: true });
  const main = opts.main ?? "lib/index.js";
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({
      name: pkgName,
      version: "1.0.0",
      main,
      peerDependencies: opts.hasLlmPeer ? { "@deepseek-ai/dsh-llm": ">=0.2.0" } : {},
    }),
  );
  await writeFile(
    join(pkgDir, main),
    opts.hasRegisterAdapter
      ? "export function apply(ctx) { ctx.llm.registerAdapter(['x'], {}); }\n"
      : "export function apply() {}\n",
  );
}

test("dsh-yaml parses subset YAML, preserves !!js comment safety, detects real !!js and inline secrets", () => {
  const yaml = `# header comment mentioning \`!!js\` safely
- id: ui-theme
  config:
    tags: [web, news]
    meta: { enabled: true, count: 2 }
    note: |
      line one
      line two
    summary: >
      folded
      text
- id: llm-pi-ai
  config:
    providers:
      clean:
        apiKeyEnv: CLEAN_API_KEY
        models:
          - id: m1
            name: 'model: one'
`;
  const parsed = parseDshPatchYaml(yaml);
  assert.equal(parsed.hasJsExpression, false);
  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(parsed.entries[0].config.tags, ["web", "news"]);
  assert.deepEqual(parsed.entries[0].config.meta, { enabled: true, count: 2 });
  assert.equal(parsed.entries[0].config.note, "line one\nline two\n");
  assert.equal(parsed.entries[0].config.summary, "folded text\n");
  assert.equal(hasInlineSecret(parsed.entries), false);

  const roundTripped = parseDshPatchYaml(stringifyDshPatchYaml(parsed.entries));
  assert.deepEqual(roundTripped.entries, parsed.entries);

  const withJs = parseDshPatchYaml("- id: bad\n  fn: !!js/function () => 1\n");
  assert.equal(withJs.hasJsExpression, true);

  assert.equal(hasInlineSecret({ apiKeyEnv: "MY_KEY" }), false);
  assert.equal(hasInlineSecret({ apiKey: "" }), false);
  assert.equal(hasInlineSecret({ apiKey: "sk-live-123" }), true);
  assert.equal(hasInlineSecret({ nested: [{ client_secret: "abc" }] }), true);
  assert.equal(hasInlineSecret({ accessToken: "tok" }), true);
  assert.equal(hasInlineSecret({ password: "pw" }), true);
});

test("diffDshDesktopModels filters pi-ai providers, plugins, secrets, !!js, and link specs", async (t) => {
  const { dshHome, env, desktopDir } = await setupMigrationFixture(t);

  await writeFile(
    join(dshHome, "cordis.patch.yml"),
    stringifyDshPatchYaml([
      {
        id: "llm-pi-ai",
        config: {
          providers: {
            "home-only": { apiKeyEnv: "HOME_KEY", models: [{ id: "h1", name: "h1" }] },
          },
        },
      },
    ]),
  );

  await writePluginPkg(desktopDir, "dsh-sample-provider", { hasLlmPeer: true, hasRegisterAdapter: true });
  await writePluginPkg(desktopDir, "dsh-local-plugin", { hasLlmPeer: true, hasRegisterAdapter: true });
  await writePluginPkg(desktopDir, "dsh-doublecheck", { hasLlmPeer: false, hasRegisterAdapter: false });
  await writePluginPkg(desktopDir, "dsh-peer-no-adapter", { hasLlmPeer: true, hasRegisterAdapter: false });
  await writePluginPkg(desktopDir, "@deepseek-ai/dsh-internal", { hasLlmPeer: true, hasRegisterAdapter: true });

  await writeFile(
    join(desktopDir, "package.json"),
    JSON.stringify({
      dsh: {
        profile: {
          bundles: [
            "@deepseek-ai/dsh-base",
            "@deepseek-ai/dsh-internal",
            "dsh-sample-provider",
            "dsh-local-plugin",
            "dsh-doublecheck",
            "dsh-peer-no-adapter",
          ],
        },
      },
      dependencies: {
        "dsh-sample-provider": "0.4.6",
        "dsh-local-plugin": "link:D:/fake/dsh-local-plugin",
        "dsh-doublecheck": "0.9.0",
        "dsh-peer-no-adapter": "1.0.0",
      },
    }),
  );

  await writeFile(
    join(desktopDir, "cordis.patch.yml"),
    `- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      custom-provider:
        displayName: Custom Provider
        apiKeyEnv: CUSTOM_PROVIDER_API_KEY
        models:
          - id: glm-5
            name: glm-5
      partial:
        displayName: Partial
        apiKeyEnv: PARTIAL_KEY
        models:
          - id: m1
            name: m1
          - id: m2
            name: m2
      home-only:
        apiKeyEnv: HOME_KEY
        models:
          - id: h1
            name: h1
      inline-secret:
        apiKey: sk-secret-value
        models:
          - id: bad
            name: bad
      js-provider:
        transform: !!js/function () { return 1; }
        models:
          - id: js1
            name: js1
- id: sample-provider
  name: dsh-sample-provider
  config:
    freeEnabled: true
`,
  );

  const diff = await diffDshDesktopModels("custom-acp", env);
  assert.equal(diff.desktopPresent, true);
  assert.equal(diff.targetProfile, "custom-acp");

  assert.deepEqual(
    diff.providers.map((p) => [p.id, p.kind, p.source, p.defaultSelected, p.hasConfigPatch]),
    [
      ["pi-ai:custom-provider", "pi-ai", undefined, true, undefined],
      ["pi-ai:partial", "pi-ai", undefined, true, undefined],
      ["plugin:dsh-sample-provider", "plugin", "registry", true, true],
      ["plugin:dsh-local-plugin", "plugin", "local-link", false, undefined],
    ],
  );
  const partial = diff.providers.find((p) => p.id === "pi-ai:partial")!;
  assert.deepEqual(partial.missingModels, ["m2"]);
  const localLink = diff.providers.find((p) => p.id === "plugin:dsh-local-plugin")!;
  assert.match(localLink.warning ?? "", /Local linked plugin/);

  assert.deepEqual(
    diff.skipped.map((s) => s.name),
    ["inline-secret", "js-provider"],
  );
});

test("dryRunDshMigration never mutates target profile, cleans staging dirs, and isolates broken providers", async (t) => {
  const { dshHome, env, desktopDir, targetDir } = await setupMigrationFixture(t);

  await writePluginPkg(desktopDir, "dsh-good", { hasLlmPeer: true, hasRegisterAdapter: true });
  await writePluginPkg(desktopDir, "dsh-bad-noise", { hasLlmPeer: true, hasRegisterAdapter: true });
  await writeFile(
    join(desktopDir, "package.json"),
    JSON.stringify({
      dsh: { profile: { bundles: ["dsh-good", "dsh-bad-noise"] } },
      dependencies: { "dsh-good": "1.0.0", "dsh-bad-noise": "1.0.0" },
    }),
  );
  await writeFile(
    join(desktopDir, "cordis.patch.yml"),
    stringifyDshPatchYaml([
      {
        id: "llm-pi-ai",
        config: {
          providers: {
            "custom-provider": { displayName: "Custom Provider", apiKeyEnv: "CUSTOM_PROVIDER_API_KEY", models: [{ id: "r1", name: "r1" }] },
          },
        },
      },
    ]),
  );

  // Stale dryrun directory > 1h old should be cleaned
  const staleDir = join(dshHome, "profiles", "memcode-dryrun-deadbeef");
  await mkdir(staleDir, { recursive: true });
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(staleDir, twoHoursAgo, twoHoursAgo);

  const mockCli = join(dshHome, "mock-dsh-acp.mjs");
  await writeFile(
    mockCli,
    `import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
if (argv[0] === "plugin") {
  const profile = argv[argv.indexOf("--profile") + 1];
  const spec = argv[argv.length - 1];
  const pkgName = spec.split("@")[0];
  const pDir = join(process.env.DSH_HOME, "profiles", profile);
  const pkgPath = join(pDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.dependencies = { ...(pkg.dependencies || {}), [pkgName]: "1.0.0" };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  mkdirSync(join(pDir, "node_modules", pkgName), { recursive: true });
  process.exit(0);
}
const profile = argv[argv.indexOf("--profile") + 1];
const pDir = join(process.env.DSH_HOME, "profiles", profile);
const pkg = JSON.parse(readFileSync(join(pDir, "package.json"), "utf8"));
if (pkg.dependencies?.["dsh-bad-noise"]) {
  process.stdout.write("NOISY_STDOUT_BEFORE_ACP\\n");
}
const send = (x) => process.stdout.write(JSON.stringify(x) + "\\n");
createInterface({ input: process.stdin }).on("close", () => process.exit(0)).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { agentCapabilities: {} } });
  if (msg.method === "session/close") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method === "session/new") {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "s1",
        configOptions: [{
          id: "model",
          category: "model",
          currentValue: "r1",
          options: [{ group: "Custom Provider", options: [{ value: "r1", name: "R1" }] }],
        }],
      },
    });
  }
});
`,
  );

  const beforePkg = await readFile(join(targetDir, "package.json"));
  const beforePatch = await readFile(join(targetDir, "cordis.patch.yml"));
  const beforeLock = await readFile(join(targetDir, "pnpm-lock.yaml"));

  const cmd = { command: process.execPath, prefix: [mockCli] };
  const result = await dryRunDshMigration(
    cmd,
    "custom-acp",
    ["pi-ai:custom-provider", "plugin:dsh-good", "plugin:dsh-bad-noise"],
    { env },
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.passedIds, ["pi-ai:custom-provider", "plugin:dsh-good"]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, "plugin:dsh-bad-noise");
  assert.match(result.failed[0].reason, /unreadable|JSON|NOISY_STDOUT/i);

  assert.equal(await exists(staleDir), false);
  const leftover = (await readdir(join(dshHome, "profiles"))).filter((n) =>
    n.startsWith("memcode-dryrun-"),
  );
  assert.deepEqual(leftover, []);

  assert.deepEqual(await readFile(join(targetDir, "package.json")), beforePkg);
  assert.deepEqual(await readFile(join(targetDir, "cordis.patch.yml")), beforePatch);
  assert.deepEqual(await readFile(join(targetDir, "pnpm-lock.yaml")), beforeLock);

  const okRun = await dryRunDshMigration(cmd, "custom-acp", ["pi-ai:custom-provider", "plugin:dsh-good"], {
    env,
  });
  assert.equal(okRun.ok, true);
  assert.deepEqual(okRun.passedIds, ["pi-ai:custom-provider", "plugin:dsh-good"]);
  assert.equal(okRun.failed.length, 0);
  assert.equal(okRun.previewModels[0]?.id, "r1");
  assert.equal(okRun.previewModels[0]?.group, "Custom Provider");
});

test("applyDshMigration merges cleanly and rolls back exact snapshot on failure", async (t) => {
  const { dshHome, env, desktopDir, targetDir } = await setupMigrationFixture(t);

  await writePluginPkg(desktopDir, "dsh-good", { hasLlmPeer: true, hasRegisterAdapter: true });
  await writeFile(
    join(desktopDir, "package.json"),
    JSON.stringify({
      dsh: { profile: { bundles: ["dsh-good"] } },
      dependencies: { "dsh-good": "1.0.0" },
    }),
  );
  await writeFile(
    join(desktopDir, "cordis.patch.yml"),
    stringifyDshPatchYaml([
      {
        id: "llm-pi-ai",
        config: {
          providers: {
            "custom-provider": { displayName: "Custom Provider", apiKeyEnv: "CUSTOM_PROVIDER_API_KEY", models: [{ id: "r1", name: "r1" }] },
          },
        },
      },
      { id: "good", name: "dsh-good", config: { enabled: true } },
    ]),
  );

  const mockCli = join(dshHome, "mock-apply.mjs");
  await writeFile(
    mockCli,
    `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
if (argv[0] === "plugin") {
  const profile = argv[argv.indexOf("--profile") + 1];
  const spec = argv[argv.length - 1];
  const pkgName = spec.split("@")[0];
  const pDir = join(process.env.DSH_HOME, "profiles", profile);
  const pkgPath = join(pDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.dependencies = { ...(pkg.dependencies || {}), [pkgName]: "1.0.0" };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  writeFileSync(join(pDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\\nupdated: true\\n");
  mkdirSync(join(pDir, "node_modules", pkgName), { recursive: true });
}
`,
  );

  const cmd = { command: process.execPath, prefix: [mockCli] };
  const beforePkg = await readFile(join(targetDir, "package.json"));
  const beforePatch = await readFile(join(targetDir, "cordis.patch.yml"));
  const beforeLock = await readFile(join(targetDir, "pnpm-lock.yaml"));

  const failedApply = await applyDshMigration(
    cmd,
    "custom-acp",
    ["pi-ai:custom-provider", "plugin:dsh-good"],
    {
      env,
      probe: async () => {
        throw new Error("Simulated post-apply probe failure");
      },
    },
  );
  assert.equal(failedApply.ok, false);
  assert.match(failedApply.failed[0]?.reason ?? "", /Simulated post-apply probe failure/);
  assert.deepEqual(await readFile(join(targetDir, "package.json")), beforePkg);
  assert.deepEqual(await readFile(join(targetDir, "cordis.patch.yml")), beforePatch);
  assert.deepEqual(await readFile(join(targetDir, "pnpm-lock.yaml")), beforeLock);
  assert.equal(await exists(join(targetDir, "node_modules", "dsh-good")), false);

  const okApply = await applyDshMigration(
    cmd,
    "custom-acp",
    ["pi-ai:custom-provider", "plugin:dsh-good"],
    {
      env,
      probe: async () => [{ id: "r1", label: "R1", group: "Custom Provider", source: "acp" }],
    },
  );
  assert.equal(okApply.ok, true);
  assert.deepEqual(okApply.appliedIds, ["pi-ai:custom-provider", "plugin:dsh-good"]);
  assert.equal(okApply.models.length, 1);

  const mergedPatch = parseDshPatchYaml(await readFile(join(targetDir, "cordis.patch.yml"), "utf8"));
  assert.equal(mergedPatch.entries.find((e) => e.id === "ui-theme")?.config?.fontSize, 14);
  assert.ok(mergedPatch.entries.find((e) => e.id === "llm-pi-ai")?.config?.providers?.partial);
  assert.ok(mergedPatch.entries.find((e) => e.id === "llm-pi-ai")?.config?.providers?.["custom-provider"]);
  assert.equal(mergedPatch.entries.find((e) => e.id === "good")?.config?.enabled, true);
  assert.equal(await exists(join(targetDir, "node_modules", "dsh-good")), true);
});
