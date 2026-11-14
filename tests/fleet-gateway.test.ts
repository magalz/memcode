import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startContextSession } from "../runtime/context/host";

test("real worker MCP exposes the bounded Fleet handshake and rejects forged identity or branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "memcode-fleet-mcp-"));
  let calls = 0;
  const session = await startContextSession(
    { call: async () => ({}) },
    {
      project: {
        id: "one",
        name: "One",
        description: "Fixture",
        path: root,
        branch: "epic/one",
        repoId: "one",
        analysis: "ready",
        createdAt: new Date().toISOString(),
      },
      workerId: "bound-worker",
      branch: "epic/one",
      scope: [],
    },
    join(root, "worker"),
    {
      coordination: async (input) => {
        calls++;
        return {
          workerId: "bound-worker",
          branch: "epic/one",
          directive: "proceed",
          plan: input.plan,
        };
      },
    },
  );
  const client = new Client({ name: "fleet-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      resolve("scripts/context-gateway.mjs"),
      session.configPath,
    ],
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      ["assess", "coordinate", "find", "understand"],
    );
    const response = await client.callTool({
      name: "coordinate",
      arguments: {
        action: "inspect",
        plan: "Preserve the earlier contract and implement the assigned feature.",
      },
    });
    assert.notEqual(response.isError, true);
    const result = JSON.parse((response.content as any)[0].text);
    assert.equal(result.workerId, "bound-worker");
    assert.equal(result.branch, "epic/one");
    assert.equal(calls, 1);
    for (const forged of [
      { workerId: "other" },
      { branch: "other" },
      { projectId: "other" },
    ]) {
      const reply = await fetch(session.endpoint, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + session.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          capability: "coordinate",
          action: "inspect",
          ...forged,
        }),
      });
      assert.equal(reply.status, 400);
    }
    assert.equal(calls, 1);
  } finally {
    await client.close();
    await session.close();
  }
});
