import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertPublicMacTrust } from "./macos-release-trust.mjs";
const path = process.argv[2];
if (!path)
  throw Error(
    "Provide the reviewed candidate.json before public Mac promotion.",
  );
const candidate = JSON.parse(await readFile(resolve(path), "utf8"));
assertPublicMacTrust(candidate.macOS);
if (
  candidate.updaterSignatureVerified !== true ||
  candidate.nativeColdStart?.passed !== true
)
  throw Error(
    "The actual updater verifier and fresh-profile native cold-start must pass before public Mac promotion.",
  );
console.log(
  JSON.stringify({
    publicReady: true,
    version: candidate.version,
    source: candidate.source,
    signing: "developer-id",
    notarized: true,
  }),
);
