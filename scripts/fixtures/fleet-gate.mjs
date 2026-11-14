import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const token = process.argv[2];
if (!/^[a-f0-9-]{36}$/.test(token ?? ""))
  throw Error("Use the supplied proof-run token.");
const path = join(resolve("."), ".memcode", "fleet-gate", token + ".json");
const deadline = Date.now() + 120000;
console.log(
  "Holding the first edit reservation until the other two real workers adopt its published plan.",
);
let released = false;
while (Date.now() < deadline) {
  const value = JSON.parse(await readFile(path, "utf8").catch(() => "null"));
  if (value?.release === true && value.token === token) {
    released = true;
    break;
  }
  await new Promise((done) => setTimeout(done, 300));
}
if (!released)
  throw Error(
    "The bounded Fleet proof gate timed out. Do not claim a handoff passed.",
  );
console.log(JSON.stringify({ released: true, token }));
