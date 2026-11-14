// The demo's only shared utility. Workers own separate apps, not this server.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, open, appendFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [command, provider, ...extra] = process.argv.slice(2);
if (!["codex", "claude", "cursor"].includes(provider))
  throw Error("Choose codex, claude, or cursor.");
const directory = join(root, ".memcode", "lab", provider);
const metaPath = join(directory, "server.json"),
  notePath = join(directory, "note.json"),
  replyPath = join(directory, "reply.json");
await mkdir(directory, { recursive: true });
const read = async (path) =>
  JSON.parse(await readFile(path, "utf8").catch(() => "null"));
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const json = (response, value, status = 200) =>
  response
    .writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    })
    .end(JSON.stringify(value));

if (command === "serve") {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (
        request.headers.origin &&
        !/^http:\/\/127\.0\.0\.1:\d+$/.test(request.headers.origin)
      )
        return json(response, { error: "Local demo origin required" }, 403);
      if (request.method === "POST" && url.pathname === "/note") {
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 4096)
            return json(response, { error: "Note too long" }, 413);
        }
        const { note } = JSON.parse(body);
        if (typeof note !== "string" || !note.trim() || note.length > 1000)
          return json(response, { error: "Enter a note" }, 400);
        const saved = {
          note: note.trim(),
          at: new Date().toISOString(),
          provider,
        };
        await writeFile(notePath, JSON.stringify(saved, null, 2));
        return json(response, { saved: true, ...saved });
      }
      if (request.method !== "GET")
        return json(response, { error: "Unsupported method" }, 405);
      if (url.pathname === "/health")
        return json(response, { ok: true, provider });
      if (url.pathname === "/note") return json(response, await read(notePath));
      if (url.pathname === "/reply")
        return json(response, await read(replyPath));
      if (url.pathname !== "/")
        return json(response, { error: "Not found" }, 404);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(await readFile(join(root, "apps", provider, "index.html")));
    } catch (error) {
      json(response, { error: error.message }, 500);
    }
  });
  const port = Number(extra[0] ?? 0);
  if (
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    (port > 0 && port < 1024)
  )
    throw Error(
      "Choose a local test port from 1024–65535 or zero for an available port.",
    );
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", done);
  });
  const meta = {
    owner: "memcode-browser-lab-v1",
    provider,
    pid: process.pid,
    root,
    url: "http://127.0.0.1:" + server.address().port,
    startedAt: new Date().toISOString(),
  };
  await writeFile(metaPath, JSON.stringify(meta, null, 2));
  console.log(JSON.stringify(meta));
  if (process.stdin.isTTY) {
    console.log(
      "Live " +
        provider +
        " dev server · type status, ping <message>, or help.",
    );
    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    terminal.on("line", async (line) => {
      if (line === "status")
        console.log(
          JSON.stringify({
            provider,
            url: meta.url,
            note: await read(notePath),
          }),
        );
      else if (line.startsWith("ping ")) {
        const message = line.slice(5);
        console.log("Terminal echo (" + provider + "): " + message);
        await appendFile(
          join(directory, "terminal-events.jsonl"),
          JSON.stringify({
            message,
            at: new Date().toISOString(),
            pid: process.pid,
          }) + "\n",
        ).catch((error) =>
          console.error("Could not save terminal test event: " + error.message),
        );
      } else console.log("Commands: status · ping <message> · help");
    });
  }
  const close = () => server.close(() => process.exit(0));
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
} else if (command === "start") {
  const prior = await read(metaPath);
  if (
    prior &&
    (await fetch(prior.url + "/health")
      .then((r) => r.ok)
      .catch(() => false))
  ) {
    console.log(JSON.stringify(prior));
  } else {
    const log = await open(join(directory, "server.log"), "a");
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "serve", provider],
      {
        cwd: root,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log.fd, log.fd],
      },
    );
    child.unref();
    await log.close();
    let ready = false;
    for (let i = 0; i < 100; i++) {
      await pause(100);
      const meta = await read(metaPath);
      if (meta && meta.pid === child.pid) {
        console.log(JSON.stringify(meta));
        ready = true;
        break;
      }
    }
    if (!ready)
      throw Error(
        "Demo server did not start. Read .memcode/lab/" +
          provider +
          "/server.log.",
      );
  }
} else if (command === "wait") {
  const timeout = Math.min(300, Math.max(5, Number(extra[0] ?? 180))) * 1000;
  const start = Date.now();
  let note;
  while (Date.now() - start < timeout) {
    note = await read(notePath);
    if (note) break;
    await pause(500);
  }
  console.log(JSON.stringify(note ?? { timeout: true, provider }));
} else if (command === "reply") {
  const reply = extra.join(" ").trim();
  if (!reply || reply.length > 2000)
    throw Error("Reply must contain 1–2000 characters.");
  const value = { reply, provider, at: new Date().toISOString() };
  await writeFile(replyPath, JSON.stringify(value, null, 2));
  console.log(JSON.stringify(value));
} else if (command === "publish") {
  const output = process.env.MEMCODE_ARTIFACT_DIR;
  if (!output) throw Error("Run publish from a MemCode worker.");
  await mkdir(output, { recursive: true });
  for (const [source, target] of [
    ["index.html", provider + "-interactive.html"],
    ["poster.svg", provider + "-poster.svg"],
    ["report.md", provider + "-report.md"],
  ]) {
    const value = await readFile(join(root, "apps", provider, source));
    await writeFile(join(output, target), value);
  }
  console.log(
    "Published three saved artifacts: interactive HTML, SVG poster, and report.",
  );
} else if (command === "status") {
  const server = await read(metaPath);
  console.log(
    JSON.stringify({
      server,
      note: await read(notePath),
      reply: await read(replyPath),
    }),
  );
} else if (command === "stop") {
  const meta = await read(metaPath);
  if (
    !meta ||
    meta.owner !== "memcode-browser-lab-v1" ||
    meta.root !== root ||
    meta.provider !== provider
  )
    throw Error("No owned demo server to stop.");
  const health = await fetch(meta.url + "/health")
    .then((r) => r.json())
    .catch(() => null);
  if (!health?.ok || health.provider !== provider)
    throw Error("Demo server identity could not be verified.");
  process.kill(meta.pid);
  console.log("Stopped " + provider + " demo server.");
} else throw Error("Use start, wait, reply, publish, status, or stop.");
