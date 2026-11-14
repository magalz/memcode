import {
  readFile,
  writeFile,
  rename,
  mkdir,
  appendFile,
} from "node:fs/promises";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { git } from "./local";

const pending = new Map<string, Promise<unknown>>();
/** Plugin aliases must not turn an existing explicit gateway denial into an allow. */
export function cursorDenyAliases(rules: string[]): string[] {
  const deny = new Set(rules);
  for (const rule of rules) {
    const match = /^Mcp\((memcode-(?:context|browser))(?=[:)])/.exec(rule);
    if (match)
      deny.add(rule.replace(match[1], "plugin-memcode-plugin-" + match[1]));
  }
  return [...deny];
}
/** Cursor reads headless tool permissions from the workspace's cli.json. */
export async function allowCursorGateway(
  workspace: string,
  tools: string[],
): Promise<void> {
  const previous = pending.get(workspace) ?? Promise.resolve();
  const write = previous
    .catch(() => {})
    .then(async () => {
      const path = join(workspace, ".cursor", "cli.json");
      let original: string | undefined;
      try {
        original = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const settings = original === undefined ? {} : JSON.parse(original);
      const allow = new Set<string>(settings.permissions?.allow ?? []);
      for (const tool of tools) allow.add(tool);
      settings.permissions = {
        ...settings.permissions,
        allow: [...allow],
        deny: cursorDenyAliases(settings.permissions?.deny ?? []),
      };
      const text = JSON.stringify(settings, null, 2) + "\n";
      if (text === original) return;
      await mkdir(dirname(path), { recursive: true });
      const next = path + "." + randomUUID() + ".next";
      await writeFile(next, text, { mode: 0o600 });
      await rename(next, path);
      if (original === undefined) {
        const gitPath = await git(workspace, [
          "rev-parse",
          "--git-path",
          "info/exclude",
        ]);
        const exclude = isAbsolute(gitPath)
          ? gitPath
          : resolve(workspace, gitPath);
        const ignored = await readFile(exclude, "utf8").catch(() => "");
        if (!ignored.split(/\r?\n/).includes("/.cursor/cli.json"))
          await appendFile(
            exclude,
            "\n# MemCode generated local adapter permissions\n/.cursor/cli.json\n",
          );
      }
    });
  pending.set(workspace, write);
  try {
    await write;
  } finally {
    if (pending.get(workspace) === write) pending.delete(workspace);
  }
}
