/** Transparent stdio observer for disposable coding evaluations only. */
import { readFile, appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const child = spawn(config.command, config.args, {
  cwd: config.cwd,
  env: { ...process.env, ...config.env },
  shell: false,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});
let pending = Promise.resolve();
const record = (value) => {
  pending = pending.then(() =>
    appendFile(config.audit, JSON.stringify(value) + "\n", { mode: 0o600 }),
  );
};
const requests = new Map();
function observe(stream, direction) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line),
          at = Date.now();
        if (direction === "request" && message.method === "tools/call") {
          requests.set(message.id, { at, tool: message.params.name });
          record({ phase: "request", at, id: message.id, ...message.params });
        } else if (direction === "response" && requests.has(message.id)) {
          const request = requests.get(message.id);
          requests.delete(message.id);
          record({
            phase: "response",
            at,
            id: message.id,
            tool: request.tool,
            elapsedMs: at - request.at,
            error: message.error ?? null,
            isError: message.result?.isError ?? false,
          });
        }
      } catch {
        /* A malformed peer message remains unchanged on the wire. */
      }
    }
  });
}
observe(process.stdin, "request");
observe(child.stdout, "response");
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.on("error", () => {});
process.stdin.on("end", () => child.kill());
process.on("SIGTERM", () => child.kill());
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("close", async (code) => {
  await pending;
  process.exit(code ?? 1);
});
