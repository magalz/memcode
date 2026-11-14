import { createInterface } from "node:readline";
import { open, readFile, unlink, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRuntime } from "./app";

const args = process.argv.slice(2),
  option = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
const dataDir = resolve(
  option("--data-dir") ??
    process.env.MEMCODE_DATA_DIR ??
    join(process.env.APPDATA ?? process.cwd(), "MemCode"),
);
const appPath = resolve(option("--app-path") ?? process.cwd());
const send = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
console.log = (...args) =>
  process.stderr.write(
    args
      .map((value) =>
        typeof value === "string" ? value : JSON.stringify(value),
      )
      .join(" ") + "\n",
  );
let nextHost = 0,
  disconnected = false,
  closing = false;
const hostPending = new Map<
  string,
  { resolve: (value: any) => void; reject: (reason: Error) => void }
>();
const host = {
  call<T>(method: string, input: unknown = {}): Promise<T> {
    if (disconnected)
      return Promise.reject(new Error("The native host has closed."));
    const id = "host-" + ++nextHost;
    return new Promise<T>((resolve, reject) => {
      hostPending.set(id, { resolve, reject });
      send({ kind: "host_request", id, method, input });
    });
  },
};
const lockPath = join(dataDir, "runtime.lock");
let ownsLock = false;
async function acquireLock() {
  await mkdir(dataDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++)
    try {
      const lock = await open(lockPath, "wx");
      await lock.writeFile(
        JSON.stringify({
          owner: "memcode-runtime",
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
      );
      await lock.close();
      ownsLock = true;
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let prior: { pid: number };
      try {
        prior = JSON.parse(await readFile(lockPath, "utf8"));
      } catch {
        throw new Error(
          "MemCode has an unreadable runtime lock. The workspace was preserved.",
        );
      }
      try {
        process.kill(prior.pid, 0);
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === "ESRCH") {
          await unlink(lockPath);
          continue;
        }
      }
      throw new Error(
        "This MemCode workspace is already open. Close its other window before starting another writer.",
      );
    }
  throw new Error("Could not acquire the MemCode workspace lock.");
}
const ready = (async () => {
  await acquireLock();
  const runtime = await createRuntime(
    dataDir,
    appPath,
    host,
    (event, payload) => send({ kind: "event", event, payload }),
  );
  const openProject =
    option("--open-project") ?? process.env.MEMCODE_OPEN_PROJECT;
  if (openProject)
    await runtime.openProject(
      resolve(openProject),
      process.env.MEMCODE_OPEN_PROJECT_NAME,
      process.env.MEMCODE_OPEN_PROJECT_DESCRIPTION,
    );
  return runtime;
})();
ready.catch((error) =>
  process.stderr.write(`MemCode runtime could not start: ${error.message}\n`),
);
async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    const app = await ready;
    await app.close();
  } catch (error) {
    process.stderr.write(`Runtime shutdown: ${(error as Error).message}\n`);
  } finally {
    if (ownsLock) {
      await unlink(lockPath).catch(() => {});
      ownsLock = false;
    }
  }
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  void (async () => {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.kind === "host_response") {
      const pending = hostPending.get(message.id);
      if (!pending) return;
      hostPending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (
      message.kind !== "request" ||
      typeof message.id !== "string" ||
      typeof message.method !== "string"
    )
      return;
    try {
      if (message.method === "runtime:shutdown") {
        await shutdown();
        send({ kind: "response", id: message.id, result: null });
        setImmediate(() => process.exit(0));
        return;
      }
      if (closing) throw new Error("The workspace is closing.");
      const app = await ready;
      const result = await app.request(message.method, message.input);
      send({ kind: "response", id: message.id, result: result ?? null });
    } catch (error) {
      send({
        kind: "response",
        id: message.id,
        error: (error as Error).message,
      });
    }
  })().catch((error) => process.stderr.write(String(error) + "\n"));
});
input.on("close", () => {
  disconnected = true;
  for (const pending of hostPending.values())
    pending.reject(new Error("Native host disconnected."));
  hostPending.clear();
  void shutdown().finally(() => process.exit(0));
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    disconnected = true;
    for (const pending of hostPending.values())
      pending.reject(new Error("Native host is shutting down."));
    hostPending.clear();
    void shutdown().finally(() => process.exit(0));
  });
