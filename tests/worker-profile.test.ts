import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, lstat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerToolProfile } from "../runtime/worker-profile";

test("worker overlays connect both MemCode gateways without changing the user's configuration or explicit deny policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "memcode-profile-test-"));
  const original = join(root, "original"),
    worker = join(root, "worker");
  await mkdir(join(original, "skills"), { recursive: true });
  await mkdir(join(original, "acp-sessions"));
  await mkdir(join(original, "projects"));
  await mkdir(worker);
  await writeFile(join(original, "skills", "example.md"), "Existing skill");
  const settings = JSON.stringify({
    approvalMode: "unrestricted",
    authInfo: { fixture: true },
    permissions: {
      allow: ["Shell(ls)"],
      deny: ["Shell(rm)", "Mcp(memcode-context:assess)"],
    },
    customSetting: "preserved",
  });
  const globalMcp = JSON.stringify({
    mcpServers: {
      memtrace: { command: "memtrace", args: ["mcp"], env: { FIXTURE: "1" } },
      unrelated: { command: "custom", args: ["serve"] },
    },
  });
  await writeFile(join(original, "cli-config.json"), settings);
  await writeFile(join(original, "mcp.json"), globalMcp);
  const config = join(worker, "context-mcp.json");
  await writeFile(
    config,
    JSON.stringify({
      mcpServers: {
        "memcode-context": {
          command: "node",
          args: ["gateway.cjs", "context-session.json"],
        },
        "memcode-browser": {
          command: "node",
          args: ["gateway.cjs", "browser-session.json"],
        },
      },
    }),
  );
  const previous = process.env.CURSOR_CONFIG_DIR;
  process.env.CURSOR_CONFIG_DIR = original;
  try {
    const cursor = await workerToolProfile("cursor", config);
    const profile = cursor.env!.CURSOR_CONFIG_DIR!;
    assert.equal(await lstat(join(profile,"acp-sessions")).catch(()=>null),null);
    assert.equal(await lstat(join(profile,"projects")).catch(()=>null),null);
    // Reusing a pre-fix profile detaches only the exact inherited junction.
    await symlink(join(original,"acp-sessions"),join(profile,"acp-sessions"),process.platform === "win32" ? "junction" : "dir");
    await workerToolProfile("cursor",config);
    assert.equal(await lstat(join(profile,"acp-sessions")).catch(()=>null),null);
    assert.ok((await lstat(join(original,"acp-sessions"))).isDirectory());
    const overlaid = JSON.parse(
      await readFile(join(profile, "cli-config.json"), "utf8"),
    );
    assert.ok(overlaid.permissions.deny.includes("Shell(rm)"));
    assert.ok(
      overlaid.permissions.deny.includes("Mcp(memcode-context:assess)"),
    );
    assert.ok(
      overlaid.permissions.deny.includes(
        "Mcp(plugin-memcode-plugin-memcode-context:assess)",
      ),
    );
    assert.ok(overlaid.permissions.allow.includes("Shell(ls)"));
    assert.ok(overlaid.permissions.allow.includes("Mcp(memcode-browser:act)"));
    assert.equal(overlaid.customSetting, "preserved");
    assert.equal(
      overlaid.approvalMode,
      "allowlist",
      "Review never inherits Run Everything",
    );
    assert.deepEqual(overlaid.authInfo, { fixture: true });
    assert.equal(
      await readFile(join(profile, "skills", "example.md"), "utf8"),
      "Existing skill",
    );
    const servers = JSON.parse(
      await readFile(join(profile, "memcode-plugin", "mcp.json"), "utf8"),
    ).mcpServers;
    assert.deepEqual(Object.keys(servers), [
      "memcode-context",
      "memcode-browser",
    ]);
    assert.ok(
      overlaid.permissions.allow.includes(
        "Mcp(plugin-memcode-plugin-memcode-browser:act)",
      ),
    );
    assert.ok(cursor.args.includes("--plugin-dir"));
    assert.equal(
      await readFile(join(original, "cli-config.json"), "utf8"),
      settings,
    );
    assert.equal(await readFile(join(original, "mcp.json"), "utf8"), globalMcp);
    await workerToolProfile("cursor", config, undefined, "full-access");
    const fullAccess = JSON.parse(
      await readFile(join(profile, "cli-config.json"), "utf8"),
    );
    assert.equal(fullAccess.approvalMode, "unrestricted");
    assert.deepEqual(fullAccess.permissions.deny, overlaid.permissions.deny);
    assert.equal(
      await readFile(join(original, "cli-config.json"), "utf8"),
      settings,
    );
    await assert.rejects(
      workerToolProfile("cursor", config, undefined, "auto"),
      /ACP transport does not support Smart auto/,
    );
    const codex = await workerToolProfile("codex", config);
    assert.ok(
      codex.args.some((arg) => arg.startsWith("mcp_servers.memcode_context=")),
    );
    assert.ok(
      codex.args.some((arg) => arg.startsWith("mcp_servers.memcode_browser=")),
    );
    assert.ok(
      !codex.args.some((arg) => /dangerously|yolo|skip.*permission/.test(arg)),
    );
    const codexFull = await workerToolProfile(
      "codex",
      config,
      undefined,
      "full-access",
    );
    assert.ok(
      codexFull.args
        .filter((arg) => arg.startsWith("mcp_servers.memcode_"))
        .every((arg) => !arg.includes('approval_mode="approve"')),
    );
  } finally {
    if (previous === undefined) delete process.env.CURSOR_CONFIG_DIR;
    else process.env.CURSOR_CONFIG_DIR = previous;
  }
});
