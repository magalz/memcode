import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { allowCursorGateway } from "../runtime/cursor-permissions";
import { git } from "../runtime/local";

test("concurrent Cursor gateway permissions preserve project settings and deny aliases", async () => {
  const repo = await mkdtemp(join(tmpdir(), "memcode-cursor-policy-"));
  await git(repo, ["init"]);
  await mkdir(join(repo, ".cursor"));
  const path = join(repo, ".cursor", "cli.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      permissions: {
        allow: ["Shell(node)"],
        deny: ["Mcp(memcode-browser:act)", "Write(secrets/**)"],
      },
    }),
  );
  await Promise.all([
    allowCursorGateway(repo, [
      "Mcp(plugin-memcode-plugin-memcode-context:find)",
    ]),
    allowCursorGateway(repo, [
      "Mcp(plugin-memcode-plugin-memcode-browser:act)",
    ]),
  ]);
  const value = JSON.parse(await readFile(path, "utf8"));
  assert.equal(value.version, 1);
  assert.ok(value.permissions.allow.includes("Shell(node)"));
  assert.ok(
    value.permissions.allow.includes(
      "Mcp(plugin-memcode-plugin-memcode-context:find)",
    ),
  );
  assert.ok(
    value.permissions.allow.includes(
      "Mcp(plugin-memcode-plugin-memcode-browser:act)",
    ),
  );
  assert.ok(value.permissions.deny.includes("Mcp(memcode-browser:act)"));
  assert.ok(
    value.permissions.deny.includes(
      "Mcp(plugin-memcode-plugin-memcode-browser:act)",
    ),
  );
  assert.ok(value.permissions.deny.includes("Write(secrets/**)"));
});
