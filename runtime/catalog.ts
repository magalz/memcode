import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  childEnv,
  commandIdentity,
  findCommand,
  findDesktopApp,
} from "./commands";
import {
  harnessNames,
  type Harness,
  type HarnessRuntime,
  type ModelOption,
  type ModelTier,
} from "../src/shared";

const execute = promisify(execFile);
const tiers: ModelTier[] = ["fast", "balanced", "frontier", "extreme"];
let cached: { at: number; value: HarnessRuntime[] } | undefined;

async function codexModels(): Promise<ModelOption[]> {
  try {
    const data = JSON.parse(
      await readFile(join(homedir(), ".codex", "models_cache.json"), "utf8"),
    ) as {
      models: Array<{
        slug: string;
        display_name?: string;
        supported_reasoning_levels?: Array<{ effort: string }>;
      }>;
    };
    const preferred = [
      ["gpt-6-luna", "gpt-5.6-luna"],
      ["gpt-6.1-terra", "gpt-5.6-terra"],
      ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"],
      ["gpt-6-astra"],
    ];
    return preferred.flatMap((choices, index) => {
      const found = choices
        .map((id) => data.models.find((m) => m.slug === id))
        .find(Boolean);
      return found
        ? [
            {
              id: found.slug,
              label: found.display_name ?? found.slug,
              tier: tiers[index],
              source: "cache" as const,
              efforts: found.supported_reasoning_levels?.map((x) => x.effort),
            },
          ]
        : [];
    });
  } catch {
    return [];
  }
}

async function cursorModels(
  command: NonNullable<Awaited<ReturnType<typeof findCommand>>>,
): Promise<ModelOption[]> {
  try {
    const { stdout } = await execute(
      command.command,
      [...command.prefix, "--list-models"],
      {
        env: { ...childEnv(), ...command.env },
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 512000,
        encoding: "utf8",
      },
    );
    const ids = new Set(
      stdout
        .replace(/\u001b\[[0-9;]*m/g, "")
        .split("\n")
        .map((line) => line.match(/^([a-z0-9][a-z0-9._-]+)\s+-\s+/)?.[1])
        .filter(Boolean),
    );
    return [
      ["composer-2.5", "fast"],
      ["grok-4.7-high", "balanced"],
      ["grok-4.7-xhigh", "frontier"],
    ]
      .filter(([id]) => ids.has(id))
      .map(([id, tier]) => ({
        id,
        label: id,
        tier: tier as ModelTier,
        source: "cli",
      }));
  } catch {
    return [];
  }
}

export async function discoverHarnesses(
  refresh = false,
): Promise<HarnessRuntime[]> {
  if (!refresh && cached && Date.now() - cached.at < 60000) return cached.value;
  const value = await Promise.all(
    (["codex", "claude", "cursor"] as Harness[]).map(async (id) => {
      const command = await findCommand(id);
      const desktopAppPath = await findDesktopApp(id);
      let models: ModelOption[] = [];
      if (command && id === "codex") models = await codexModels();
      if (command && id === "cursor") models = await cursorModels(command);
      if (command && id === "claude")
        models = ["haiku", "sonnet", "opus", "fable"].map((id, index) => ({
          id,
          label: id[0].toUpperCase() + id.slice(1),
          tier: tiers[index],
          source: "alias",
          efforts: ["low", "medium", "high", "xhigh"],
        }));
      return {
        id,
        name: harnessNames[id],
        available: !!command,
        path: command?.command ?? null,
        ...(command ? { runtimeIdentity: commandIdentity(command) } : {}),
        ...(desktopAppPath ? { desktopAppPath } : {}),
        models,
        note: command
          ? models.length
            ? "Model identifiers from local cache, CLI discovery or documented CLI aliases. Access is confirmed by the provider when a run starts."
            : "Automatic model selection requires a discovered catalog."
          : id === "cursor"
            ? "Install the standalone Cursor Agent CLI; the editor alone is not a worker runtime."
            : "No supported local CLI runtime was found.",
      };
    }),
  );
  cached = { at: Date.now(), value };
  return value;
}
