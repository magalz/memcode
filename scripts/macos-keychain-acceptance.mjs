// Native credential rotation acceptance on a disposable GitHub Mac only.
// The Rust test owns a synthetic encrypted Keychain and restores CI preferences.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "darwin");
assert.equal(process.env.GITHUB_ACTIONS, "true", "Use a disposable GitHub runner");
assert.equal(process.env.MEMCODE_MAC_KEYCHAIN_TEST, "1", "Explicit synthetic test required");
const cwd = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync("cargo", [
  "test", "--manifest-path", "src-tauri/Cargo.toml", "--locked", "--release",
  "--features", "custom-protocol",
  "beta_store::tests::macos_rotation_updates_in_place_without_decrypting_or_changing_acl",
  "--", "--exact", "--nocapture", "--test-threads=1",
], { cwd, encoding: "utf8", timeout: 540_000, maxBuffer: 16 * 1024 * 1024 });
const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
const passed = result.status === 0 && output.includes("MAC_KEYCHAIN_ROTATION_PASS:")
  && /test result: ok\. 1 passed; 0 failed; 0 ignored;/.test(output);
mkdirSync(new URL("../release/", import.meta.url), { recursive: true });
writeFileSync(new URL("../release/macos-keychain-rotation.json", import.meta.url), JSON.stringify({
  passed,
  platform: process.platform,
  sourceCommit: process.env.GITHUB_SHA,
  checkedAt: new Date().toISOString(),
  syntheticEncryptedKeychainOnly: true,
  normalAccountCredentialsUsed: false,
  rotationCount: passed ? 8 : 0,
  decryptDeniedDuringRotation: passed,
  userInteractionDisabledDuringRotation: passed,
  originalItemAndAclPreserved: passed,
  finalSyntheticValueVerified: passed,
  runnerSearchListAndDefaultRestored: passed,
  ...(passed ? {} : { failure: result.error?.code === "ETIMEDOUT" ? "native-test-timeout" : "native-test-failed" }),
}, null, 2) + "\n");
console.log(output);
assert.ok(passed, "Native synthetic Keychain rotation acceptance failed");
