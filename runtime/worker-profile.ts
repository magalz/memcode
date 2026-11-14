import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  copyFile,
  stat,
  symlink,
  chmod,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Harness } from "../src/shared";
import { allowCursorGateway, cursorDenyAliases } from "./cursor-permissions";

export interface WorkerToolProfile {
  args: string[];
  env?: NodeJS.ProcessEnv;
}
const toml = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(toml).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.entries(value)
          .map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`)
          .join(",")}}`
      : JSON.stringify(value);

/** Per-worker overlays preserve user authentication, rules, hooks and explicit deny policy. */
export async function workerToolProfile(
  harness: Harness,
  configPath: string,
  workspace?: string,
): Promise<WorkerToolProfile> {
  const { mcpServers } = JSON.parse(await readFile(configPath, "utf8"));
  if (harness === "claude") return { args: [] };
  if (harness === "codex") {
    const args = [
      "-c",
      'mcp_servers.memtrace={command="memtrace",args=["mcp"],enabled=false}',
    ];
    for (const [name, config] of Object.entries(mcpServers) as [
      string,
      { command: string; args: string[] },
    ][]) {
      args.push(
        "-c",
        `mcp_servers.${name.replaceAll("-", "_")}=` +
          toml({
            command: config.command,
            args: config.args,
            enabled: true,
            required: true,
            startup_timeout_sec: 30,
            tool_timeout_sec: 120,
            default_tools_approval_mode: "auto",
            ...(name === "memcode-context"
              ? {
                  tools: {
                    coordinate: { approval_mode: "approve" },
                    terminal: { approval_mode: "approve" },
                  },
                }
              : {}),
            ...(name === "memcode-browser"
              ? {
                  tools: {
                    open: { approval_mode: "approve" },
                    act: { approval_mode: "approve" },
                  },
                }
              : {}),
          }),
      );
    }
    return { args };
  }
  const original =
    process.env.CURSOR_CONFIG_DIR?.trim() ||
    (process.env.XDG_CONFIG_HOME?.trim()
      ? join(process.env.XDG_CONFIG_HOME, "cursor")
      : join(homedir(), ".cursor"));
  const profile = join(dirname(configPath), "cursor-profile");
  await mkdir(profile, { recursive: true });
  for (const entry of await readdir(original, { withFileTypes: true }).catch(
    () => [],
  )) {
    if (["cli-config.json", "mcp.json"].includes(entry.name)) continue;
    const from = join(original, entry.name),
      to = join(profile, entry.name);
    if ((await stat(from)).isDirectory())
      await symlink(
        from,
        to,
        process.platform === "win32" ? "junction" : "dir",
      ).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
    else {
      await copyFile(from, to);
      await chmod(to, 0o600);
    }
  }
  const settings = JSON.parse(
    await readFile(join(original, "cli-config.json"), "utf8").catch(() => "{}"),
  );
  const allow = new Set<string>(settings.permissions?.allow ?? []);
  const gatewayTools: string[] = [];
  for (const name of Object.keys(mcpServers))
    for (const tool of name === "memcode-browser"
      ? ["open", "observe", "act"]
      : ["find", "understand", "assess", "coordinate", "terminal"])
      for (const namespace of [name, "plugin-memcode-plugin-" + name]) {
        const rule = `Mcp(${namespace}:${tool})`;
        allow.add(rule);
        gatewayTools.push(rule);
      }
  if (workspace) await allowCursorGateway(workspace, gatewayTools);
  settings.permissions = {
    ...settings.permissions,
    allow: [...allow],
    deny: cursorDenyAliases(settings.permissions?.deny ?? []),
  };
  await writeFile(join(profile, "cli-config.json"), JSON.stringify(settings), {
    mode: 0o600,
  });
  // Cursor's MCP loader reads ~/.cursor/mcp.json directly; CURSOR_CONFIG_DIR
  // only relocates CLI settings. Use its explicit per-invocation plugin path.
  const plugin = join(profile, "memcode-plugin");
  await mkdir(join(plugin, ".cursor-plugin"), { recursive: true });
  await writeFile(
    join(plugin, ".cursor-plugin", "plugin.json"),
    JSON.stringify({
      name: "memcode-worker",
      version: "0.1.0",
      mcpServers: "mcp.json",
    }),
    { mode: 0o600 },
  );
  await writeFile(join(plugin, "mcp.json"), JSON.stringify({ mcpServers }), {
    mode: 0o600,
  });
  return {
    args: ["--approve-mcps", "--plugin-dir", plugin],
    env: { CURSOR_CONFIG_DIR: profile },
  };
}
