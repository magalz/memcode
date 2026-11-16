import { spawn } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeBuildEnv } from "./tauri-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.argv[2])
  throw Error(
    "Usage: node scripts/verify-desktop-candidate.mjs <updater-payload>",
  );
const artifact = resolve(process.argv[2]);
await access(artifact + ".sig");
const info = await stat(artifact);
if (!info.isFile() || info.size < 1 || info.size > 1_500_000_000)
  throw Error("Candidate is not a bounded release artifact");
const env = nativeBuildEnv({ MEMCODE_CANDIDATE_UPDATER: artifact });
// Verification needs only the production public key embedded in source.
delete env.TAURI_SIGNING_PRIVATE_KEY;
delete env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
const child = spawn(
  "cargo",
  [
    "test",
    "--manifest-path",
    resolve(root, "src-tauri/Cargo.toml"),
    "updates::tests::updater_verifies_packaged_candidate",
    "--",
    "--ignored",
    "--exact",
    "--nocapture",
  ],
  { cwd: root, env, stdio: "inherit", windowsHide: true },
);
const code = await new Promise((accept, reject) => {
  child.once("error", reject);
  child.once("exit", accept);
});
if (code !== 0) process.exit(code ?? 1);
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
console.log(
  JSON.stringify(
    {
      product: "MemCode",
      version: pkg.version,
      artifact,
      bytes: info.size,
      sha256: createHash("sha256")
        .update(await readFile(artifact))
        .digest("hex"),
      updaterSignature: "verified",
      tampering: "rejected",
      wrongKey: "rejected",
      relabelledVersion: "rejected",
      osCodeSigning: "not established by updater verification",
      installed: false,
    },
    null,
    2,
  ),
);
