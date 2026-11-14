import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { findSchema, understandSchema, assessSchema } from "./contracts";
import { loopbackUrl } from "./local-model";
import { runBrowserGateway } from "../browser/gateway";
import { coordinationSchema } from "../fleet-requests";
import { terminalRequestSchema } from "../../src/terminal";

export async function runContextGateway(configPath: string): Promise<void> {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (config.kind === "browser") return runBrowserGateway(config);
  const endpoint = loopbackUrl(config.endpoint);
  if (endpoint.pathname !== "/context" || !/^[a-f0-9]{64}$/.test(config.token))
    throw new Error("Invalid host-bound context session");
  const server = new McpServer({ name: "memcode-context", version: "1.0.0" });
  for (const [name, schema, description] of [
    [
      "find",
      findSchema,
      "Find code with scoped graph search and verified literal excerpts. Text fallback needs a narrow scope and explicit reason.",
    ],
    [
      "understand",
      understandSchema,
      "Understand one exact symbol: literal source, observed callers/dependencies and refreshed constraints. Ambiguity requires selecting a file.",
    ],
    [
      "assess",
      assessSchema,
      "Assess a declared change using source, preflight and constraints. Suggestions are not executed checks. Fleet decisions remain with the host.",
    ],
  ] as const) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (input: Record<string, unknown>) => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + config.token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ capability: name, ...input }),
          signal: AbortSignal.timeout(120000),
          redirect: "error",
        });
        const text = await response.text();
        return {
          content: [{ type: "text" as const, text }],
          ...(response.ok ? {} : { isError: true }),
        };
      },
    );
  }
  if (config.coordination)
    server.registerTool(
      "coordinate",
      {
        description:
          "Coordinate BEFORE each source edit. Inspect earlier published plans; adhere/adopt and wait for the first owner. Propose an explicit alternative when you disagree; the owner responds accept/reject. Only unresolved semantic disagreement needs a human. Identity and branch are host-bound.",
        inputSchema: coordinationSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (input) => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + config.token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ capability: "coordinate", ...input }),
          signal: AbortSignal.timeout(30000),
          redirect: "error",
        });
        return {
          content: [{ type: "text" as const, text: await response.text() }],
          ...(response.ok ? {} : { isError: true }),
        };
      },
    );
  if (config.terminal)
    server.registerTool(
      "terminal",
      {
        description:
          "Shared persistent terminal for dev servers, watchers and REPLs. Start executable+args (no detached shell). List existing sessions first. Observe incremental output with sessionId/after seq; write sends real input to that same PTY. The user sees and controls it in the card. Routine short shell commands stay native.",
        inputSchema: terminalRequestSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (input) => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + config.token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ capability: "terminal", ...input }),
          signal: AbortSignal.timeout(30000),
          redirect: "error",
        });
        const result = await response.json();
        // PTY bytes go directly to the UI. Models receive bounded readable output.
        if (result && typeof result === "object") delete result.chunks;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          ...(response.ok ? {} : { isError: true }),
        };
      },
    );
  await server.connect(new StdioServerTransport());
}
