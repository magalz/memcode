import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type {
  DshDesktopDiff,
  DshDesktopProviderCandidate,
  DshDryRunResult,
  DshProviderFailure,
  DshSkippedDesktopItem,
  ModelOption,
} from "../src/shared";
import { probeStandardCatalog } from "./agents/standard-acp";
import { childEnv, exists, type Command } from "./commands";
import {
  inspectDshProfiles,
  isTemporaryDryRunProfile,
  normalizeDshProfile,
  resolveDshHome,
} from "./dsh-profiles";
import {
  hasInlineSecret,
  hasJsTag,
  parseDshPatchYaml,
  stringifyDshPatchYaml,
} from "./dsh-yaml";

const execFileAsync = promisify(execFile);
const STALE_DRYRUN_AGE_MS = 60 * 60 * 1000;
const SNAPSHOT_FILES = ["package.json", "cordis.patch.yml", "pnpm-lock.yaml"] as const;
const STAGING_COPY_FILES = [
  "package.json",
  "cordis.patch.yml",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
] as const;

export type StrictAcpProbe = (profile: string, command: Command) => Promise<ModelOption[]>;

interface DesktopPatchData {
  piAiProviders: Map<string, Record<string, unknown>>;
  pluginConfigRows: Map<string, Record<string, unknown>>;
  diff: DshDesktopDiff;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildDshEnv(dshHome: string, command: Command, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...childEnv(),
    ...command.env,
    ...(env !== process.env ? env : {}),
    DSH_HOME: dshHome,
  };
}

function withDshHomeCommand(command: Command, dshHome: string, env: NodeJS.ProcessEnv): Command {
  return {
    ...command,
    env: {
      ...command.env,
      ...(env !== process.env && env.PATH ? { PATH: env.PATH } : {}),
      DSH_HOME: dshHome,
    },
  };
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const err = error as Error & { stderr?: string; stdout?: string };
    const detail = err.stderr?.trim() || err.stdout?.trim();
    return detail ? `${err.message}: ${detail}` : err.message;
  }
  return String(error);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readJsonSafe(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function readPatchSafe(path: string): Promise<{ entries: any[]; hasJsExpression: boolean }> {
  try {
    return parseDshPatchYaml(await readFile(path, "utf8"));
  } catch {
    return { entries: [], hasJsExpression: false };
  }
}

function extractPiAiProviders(entries: unknown[]): {
  providers: Map<string, Record<string, unknown>>;
  tainted: boolean;
} {
  const providers = new Map<string, Record<string, unknown>>();
  let tainted = false;
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue;
    if (entry.id !== "llm-pi-ai" && entry.name !== "@deepseek-ai/dsh-llm-pi-ai") continue;
    const config = entry.config;
    if (!isPlainObject(config)) continue;
    const rawProviders = config.providers;
    if (!isPlainObject(rawProviders)) {
      if (hasJsTag(config)) tainted = true;
      continue;
    }
    for (const [providerId, providerConfig] of Object.entries(rawProviders)) {
      if (isPlainObject(providerConfig)) {
        providers.set(providerId, providerConfig);
      }
    }
  }
  return { providers, tainted };
}

function extractModelIds(providerConfig: Record<string, unknown>): string[] {
  if (!Array.isArray(providerConfig.models)) return [];
  const ids: string[] = [];
  for (const model of providerConfig.models) {
    if (typeof model === "string" && model.trim()) ids.push(model.trim());
    else if (isPlainObject(model)) {
      const id = typeof model.id === "string" ? model.id.trim() : typeof model.name === "string" ? model.name.trim() : "";
      if (id) ids.push(id);
    }
  }
  return ids;
}

function findMatchingPluginRow(
  entries: unknown[],
  pkgName: string,
): Record<string, unknown> | undefined {
  const shortName = pkgName.replace(/^@[^/]+\//, "").replace(/^dsh-/, "");
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue;
    if (Array.isArray(entry.insert) && !entry.id && !entry.name) continue;
    if (entry.name === pkgName || entry.id === shortName || entry.id === pkgName) {
      return entry;
    }
  }
  return undefined;
}

function buildPluginSpec(pkgName: string, rawSpec: unknown): {
  spec: string;
  source: "registry" | "local-link";
  defaultSelected: boolean;
  warning?: string;
} {
  const trimmed = typeof rawSpec === "string" ? rawSpec.trim() : "";
  if (trimmed.startsWith("link:") || trimmed.startsWith("file:")) {
    return {
      spec: trimmed,
      source: "local-link",
      defaultSelected: false,
      warning: "Local linked plugin may add non-LLM hooks or require Desktop services.",
    };
  }
  const spec = trimmed
    ? /^(?:https?:|git\+|npm:|github:|workspace:)/i.test(trimmed)
      ? trimmed
      : `${pkgName}@${trimmed}`
    : pkgName;
  return {
    spec,
    source: "registry",
    defaultSelected: true,
  };
}

async function computeDesktopDiff(
  targetProfile: string,
  env: NodeJS.ProcessEnv,
): Promise<DesktopPatchData> {
  const normalizedTarget = normalizeDshProfile(targetProfile);
  const dshHome = resolveDshHome(env);
  const desktopDir = join(dshHome, "profiles", "desktop");
  const targetDir = join(dshHome, "profiles", normalizedTarget);

  if (!(await isDirectory(desktopDir))) {
    return {
      piAiProviders: new Map(),
      pluginConfigRows: new Map(),
      diff: {
        targetProfile: normalizedTarget,
        desktopPresent: false,
        providers: [],
        skipped: [],
      },
    };
  }

  const [desktopPatch, desktopPkg, targetPatch, targetPkg, homePatch] = await Promise.all([
    readPatchSafe(join(desktopDir, "cordis.patch.yml")),
    readJsonSafe(join(desktopDir, "package.json")),
    readPatchSafe(join(targetDir, "cordis.patch.yml")),
    readJsonSafe(join(targetDir, "package.json")),
    readPatchSafe(join(dshHome, "cordis.patch.yml")),
  ]);

  const providers: DshDesktopProviderCandidate[] = [];
  const skipped: DshSkippedDesktopItem[] = [];
  const piAiProviders = new Map<string, Record<string, unknown>>();
  const pluginConfigRows = new Map<string, Record<string, unknown>>();

  const desktopPiAi = extractPiAiProviders(desktopPatch.entries);
  const existingModels = new Map<string, Set<string>>();
  for (const patch of [homePatch, targetPatch]) {
    const extracted = extractPiAiProviders(patch.entries);
    for (const [providerId, cfg] of extracted.providers) {
      let set = existingModels.get(providerId);
      if (!set) {
        set = new Set<string>();
        existingModels.set(providerId, set);
      }
      for (const modelId of extractModelIds(cfg)) set.add(modelId);
    }
  }

  if (desktopPiAi.tainted) {
    skipped.push({
      name: "llm-pi-ai",
      reason: "Desktop llm-pi-ai configuration contains !!js expression and was skipped.",
    });
  } else {
    for (const [providerId, cfg] of desktopPiAi.providers) {
      if (hasJsTag(cfg)) {
        skipped.push({
          name: providerId,
          reason: "Contains !!js expression; skipped for safety.",
        });
        continue;
      }
      if (hasInlineSecret(cfg)) {
        skipped.push({
          name: providerId,
          reason: "Contains inline credential or secret; use apiKeyEnv or .credentials.yaml.",
        });
        continue;
      }
      const models = extractModelIds(cfg);
      const existing = existingModels.get(providerId);
      const missingModels = existing ? models.filter((m) => !existing.has(m)) : undefined;
      if (existing && (!missingModels || missingModels.length === 0)) continue;

      piAiProviders.set(providerId, cfg);
      const displayName =
        typeof cfg.displayName === "string" && cfg.displayName.trim()
          ? cfg.displayName.trim()
          : providerId;
      providers.push({
        id: `pi-ai:${providerId}`,
        kind: "pi-ai",
        name: displayName,
        providerId,
        models,
        ...(missingModels ? { missingModels } : {}),
        defaultSelected: true,
      });
    }
  }

  const targetPackages = new Set<string>([
    ...(Array.isArray((targetPkg.dsh as { profile?: { bundles?: unknown[] } } | undefined)?.profile?.bundles)
      ? ((targetPkg.dsh as { profile: { bundles: unknown[] } }).profile.bundles.filter(
          (b): b is string => typeof b === "string",
        ))
      : []),
    ...(isPlainObject(targetPkg.dependencies) ? Object.keys(targetPkg.dependencies) : []),
  ]);

  const desktopBundles = Array.isArray(
    (desktopPkg.dsh as { profile?: { bundles?: unknown[] } } | undefined)?.profile?.bundles,
  )
    ? ((desktopPkg.dsh as { profile: { bundles: unknown[] } }).profile.bundles.filter(
        (b): b is string => typeof b === "string",
      ))
    : [];
  const desktopDeps = isPlainObject(desktopPkg.dependencies) ? desktopPkg.dependencies : {};
  const desktopPackages = [...new Set([...desktopBundles, ...Object.keys(desktopDeps)])];

  for (const pkgName of desktopPackages) {
    if (pkgName.startsWith("@deepseek-ai/") || targetPackages.has(pkgName)) continue;

    const pkgDir = join(desktopDir, "node_modules", ...pkgName.split("/"));
    const pkgJson = await readJsonSafe(join(pkgDir, "package.json"));
    const peers = isPlainObject(pkgJson.peerDependencies) ? pkgJson.peerDependencies : null;
    if (!peers || !Object.prototype.hasOwnProperty.call(peers, "@deepseek-ai/dsh-llm")) {
      continue;
    }

    const exportsField = isPlainObject(pkgJson.exports) ? pkgJson.exports : null;
    const dotExport = exportsField && isPlainObject(exportsField["."]) ? exportsField["."] : null;
    const mainRel =
      typeof pkgJson.main === "string" && pkgJson.main.trim()
        ? pkgJson.main.trim()
        : typeof dotExport?.default === "string"
          ? dotExport.default
          : typeof exportsField?.["."] === "string"
            ? (exportsField["."] as string)
            : "";
    if (!mainRel) continue;

    const mainPath = join(pkgDir, mainRel);
    if (relative(pkgDir, mainPath).startsWith("..")) continue;
    let mainSource = "";
    try {
      mainSource = await readFile(mainPath, "utf8");
    } catch {
      continue;
    }
    if (!mainSource.includes("registerAdapter(")) continue;

    const { spec, source, defaultSelected, warning } = buildPluginSpec(pkgName, desktopDeps[pkgName]);
    const configRow = findMatchingPluginRow(desktopPatch.entries, pkgName);
    let hasConfigPatch = false;
    if (configRow) {
      if (hasJsTag(configRow) || hasInlineSecret(configRow)) {
        skipped.push({
          name: pkgName,
          reason: "Desktop config row contains !!js or inline secrets and was skipped.",
        });
      } else {
        pluginConfigRows.set(pkgName, configRow);
        hasConfigPatch = true;
      }
    }

    providers.push({
      id: `plugin:${pkgName}`,
      kind: "plugin",
      name: pkgName,
      providerId: pkgName,
      models: [],
      source,
      spec,
      ...(hasConfigPatch ? { hasConfigPatch: true } : {}),
      defaultSelected,
      ...(warning ? { warning } : {}),
    });
  }

  return {
    piAiProviders,
    pluginConfigRows,
    diff: {
      targetProfile: normalizedTarget,
      desktopPresent: true,
      providers,
      skipped,
    },
  };
}

export async function diffDshDesktopModels(
  targetProfile: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DshDesktopDiff> {
  return (await computeDesktopDiff(targetProfile, env)).diff;
}

function mergePatchEntries(
  existingEntries: any[],
  selectedIds: string[],
  data: DesktopPatchData,
): any[] {
  const entries = cloneJson(existingEntries);
  const selectedPiAi = selectedIds
    .filter((id) => id.startsWith("pi-ai:"))
    .map((id) => id.slice("pi-ai:".length));

  if (selectedPiAi.length > 0) {
    let piAiEntry = entries.find(
      (entry) =>
        isPlainObject(entry) &&
        (entry.id === "llm-pi-ai" || entry.name === "@deepseek-ai/dsh-llm-pi-ai"),
    );
    if (!piAiEntry) {
      piAiEntry = {
        id: "llm-pi-ai",
        name: "@deepseek-ai/dsh-llm-pi-ai",
        config: { providers: {} },
      };
      entries.push(piAiEntry);
    }
    if (!isPlainObject(piAiEntry.config)) piAiEntry.config = {};
    if (!isPlainObject(piAiEntry.config.providers)) piAiEntry.config.providers = {};

    for (const providerId of selectedPiAi) {
      const desktopCfg = data.piAiProviders.get(providerId);
      if (!desktopCfg) continue;
      const existingCfg = piAiEntry.config.providers[providerId];
      if (!isPlainObject(existingCfg)) {
        piAiEntry.config.providers[providerId] = cloneJson(desktopCfg);
      } else if (Array.isArray(desktopCfg.models)) {
        const currentModels = Array.isArray(existingCfg.models) ? existingCfg.models : [];
        const existingIds = new Set(extractModelIds(existingCfg));
        for (const model of desktopCfg.models) {
          const modelId =
            typeof model === "string"
              ? model
              : isPlainObject(model)
                ? (typeof model.id === "string" ? model.id : typeof model.name === "string" ? model.name : "")
                : "";
          if (modelId && !existingIds.has(modelId)) {
            currentModels.push(cloneJson(model));
            existingIds.add(modelId);
          }
        }
        existingCfg.models = currentModels;
      }
    }
  }

  for (const id of selectedIds) {
    if (!id.startsWith("plugin:")) continue;
    const pkgName = id.slice("plugin:".length);
    const row = data.pluginConfigRows.get(pkgName);
    if (!row) continue;
    const alreadyExists = entries.some(
      (entry) =>
        isPlainObject(entry) &&
        ((row.id !== undefined && entry.id === row.id) ||
          (row.name !== undefined && entry.name === row.name)),
    );
    if (!alreadyExists) {
      entries.push(cloneJson(row));
    }
  }

  return entries;
}

async function applySelectedToProfileDir(
  command: Command,
  profileName: string,
  profileDir: string,
  selectedIds: string[],
  data: DesktopPatchData,
  dshHome: string,
  env: NodeJS.ProcessEnv,
  onPluginStart?: (id: string, pkgName: string) => void,
): Promise<void> {
  const byId = new Map(data.diff.providers.map((p) => [p.id, p]));
  for (const id of selectedIds) {
    if (!id.startsWith("plugin:")) continue;
    const candidate = byId.get(id);
    if (!candidate) {
      throw new Error(`Selected migration candidate "${id}" was not found in Desktop profile.`);
    }
    const spec = candidate.spec ?? candidate.providerId;
    onPluginStart?.(id, candidate.name);
    await execFileAsync(
      command.command,
      [...command.prefix, "plugin", "--profile", profileName, "add", spec],
      {
        shell: false,
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf8",
        env: buildDshEnv(dshHome, command, env),
      },
    );
  }

  const patchPath = join(profileDir, "cordis.patch.yml");
  const currentPatch = await readPatchSafe(patchPath);
  const merged = mergePatchEntries(currentPatch.entries, selectedIds, data);
  await writeFile(patchPath, stringifyDshPatchYaml(merged), "utf8");
}

async function cleanupStaleDryRunDirs(profilesDir: string): Promise<void> {
  try {
    const entries = await readdir(profilesDir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory() || !isTemporaryDryRunProfile(entry.name)) continue;
      const dir = join(profilesDir, entry.name);
      try {
        const info = await stat(dir);
        if (now - info.mtimeMs > STALE_DRYRUN_AGE_MS) {
          await rm(dir, { recursive: true, force: true });
        }
      } catch {
        /* Ignore transient cleanup failure. */
      }
    }
  } catch {
    /* profilesDir may not exist yet. */
  }
}

async function assertExistingAcpProfile(
  profile: string,
  env: NodeJS.ProcessEnv,
): Promise<{ dshHome: string; normalizedTarget: string; targetDir: string }> {
  const normalizedTarget = normalizeDshProfile(profile);
  const inspected = await inspectDshProfiles(normalizedTarget, env);
  if (inspected.activeProfileIssue === "missing") {
    throw new Error(`DeepSeek Harness profile "${normalizedTarget}" does not exist.`);
  }
  if (inspected.activeProfileIssue === "non-acp") {
    throw new Error(`DeepSeek Harness profile "${normalizedTarget}" is not an ACP profile.`);
  }
  return {
    dshHome: inspected.dshHome,
    normalizedTarget,
    targetDir: join(inspected.dshHome, "profiles", normalizedTarget),
  };
}

export async function dryRunDshMigration(
  command: Command,
  targetProfile: string,
  selectedIds: string[],
  options?: { env?: NodeJS.ProcessEnv; probe?: StrictAcpProbe },
): Promise<DshDryRunResult> {
  const env = options?.env ?? process.env;
  const { dshHome, normalizedTarget, targetDir } = await assertExistingAcpProfile(targetProfile, env);
  const profilesDir = join(dshHome, "profiles");
  await cleanupStaleDryRunDirs(profilesDir);

  const probeCmd = withDshHomeCommand(command, dshHome, env);
  const probe: StrictAcpProbe =
    options?.probe ??
    ((profile, cmd) => probeStandardCatalog("dsh", cmd, profile, { strictStdout: true }));

  if (selectedIds.length === 0) {
    const previewModels = await probe(normalizedTarget, probeCmd);
    return {
      ok: true,
      targetProfile: normalizedTarget,
      passedIds: [],
      failed: [],
      previewModels,
    };
  }

  const data = await computeDesktopDiff(normalizedTarget, env);
  const candidateMap = new Map(data.diff.providers.map((p) => [p.id, p]));

  const runStaging = async (ids: string[]): Promise<ModelOption[]> => {
    const stagingName = `memcode-dryrun-${randomBytes(4).toString("hex")}`;
    const stagingDir = join(profilesDir, stagingName);
    await mkdir(stagingDir, { recursive: true });
    try {
      for (const file of STAGING_COPY_FILES) {
        const src = join(targetDir, file);
        if (await exists(src)) {
          await copyFile(src, join(stagingDir, file));
        }
      }
      await applySelectedToProfileDir(command, stagingName, stagingDir, ids, data, dshHome, env);
      return await probe(stagingName, probeCmd);
    } finally {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  try {
    const previewModels = await runStaging(selectedIds);
    return {
      ok: true,
      targetProfile: normalizedTarget,
      passedIds: [...selectedIds],
      failed: [],
      previewModels,
    };
  } catch {
    const passedIds: string[] = [];
    const failed: DshProviderFailure[] = [];
    for (const id of selectedIds) {
      const candidate = candidateMap.get(id);
      try {
        await runStaging([id]);
        passedIds.push(id);
      } catch (error) {
        failed.push({
          id,
          name: candidate?.name ?? id,
          reason: extractErrorMessage(error),
        });
      }
    }
    return {
      ok: false,
      targetProfile: normalizedTarget,
      passedIds,
      failed,
      previewModels: [],
    };
  }
}

export async function applyDshMigration(
  command: Command,
  targetProfile: string,
  selectedIds: string[],
  options?: { env?: NodeJS.ProcessEnv; probe?: StrictAcpProbe },
): Promise<{
  ok: boolean;
  appliedIds: string[];
  failed: DshProviderFailure[];
  models: ModelOption[];
}> {
  const env = options?.env ?? process.env;
  const { dshHome, normalizedTarget, targetDir } = await assertExistingAcpProfile(targetProfile, env);
  const probeCmd = withDshHomeCommand(command, dshHome, env);
  const probe: StrictAcpProbe =
    options?.probe ??
    ((profile, cmd) => probeStandardCatalog("dsh", cmd, profile, { strictStdout: true }));

  if (selectedIds.length === 0) {
    const models = await probe(normalizedTarget, probeCmd);
    return { ok: true, appliedIds: [], failed: [], models };
  }

  const data = await computeDesktopDiff(normalizedTarget, env);
  const candidateMap = new Map(data.diff.providers.map((p) => [p.id, p]));

  const snapshots = new Map<string, Buffer | null>();
  for (const file of SNAPSHOT_FILES) {
    const path = join(targetDir, file);
    try {
      snapshots.set(file, await readFile(path));
    } catch {
      snapshots.set(file, null);
    }
  }

  const selectedPlugins = selectedIds
    .filter((id) => id.startsWith("plugin:"))
    .map((id) => id.slice("plugin:".length));
  const preExistingPlugins = new Set<string>();
  for (const pkgName of selectedPlugins) {
    if (await exists(join(targetDir, "node_modules", ...pkgName.split("/")))) {
      preExistingPlugins.add(pkgName);
    }
  }

  let activeId = selectedIds[0] ?? "migration";
  let activeName = candidateMap.get(activeId)?.name ?? activeId;
  try {
    await applySelectedToProfileDir(
      command,
      normalizedTarget,
      targetDir,
      selectedIds,
      data,
      dshHome,
      env,
      (id, name) => {
        activeId = id;
        activeName = name;
      },
    );
    const models = await probe(normalizedTarget, probeCmd);
    return {
      ok: true,
      appliedIds: [...selectedIds],
      failed: [],
      models,
    };
  } catch (error) {
    for (const [file, content] of snapshots) {
      const path = join(targetDir, file);
      if (content === null) {
        await rm(path, { force: true }).catch(() => {});
      } else {
        await writeFile(path, content).catch(() => {});
      }
    }
    for (const pkgName of selectedPlugins) {
      if (!preExistingPlugins.has(pkgName)) {
        await rm(join(targetDir, "node_modules", ...pkgName.split("/")), {
          recursive: true,
          force: true,
        }).catch(() => {});
      }
    }
    return {
      ok: false,
      appliedIds: [],
      failed: [
        {
          id: activeId,
          name: activeName,
          reason: extractErrorMessage(error),
        },
      ],
      models: [],
    };
  }
}
