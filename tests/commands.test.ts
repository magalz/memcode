import test from "node:test";
import assert from "node:assert/strict";
import { childEnv } from "../runtime/commands";

test("standalone workers keep their configuration without claiming the desktop parent's Core identity", () => {
  const keys = [
    "CODEX_WINDOWS_REGISTERED_CORE",
    "CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY",
  ] as const;
  const before = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) process.env[key] = "parent-process-only";
    const child = childEnv();
    for (const key of keys) {
      assert.equal(child[key], undefined);
      assert.equal(process.env[key], "parent-process-only");
    }
    assert.equal(child.USERPROFILE, process.env.USERPROFILE);
    assert.equal(child.CODEX_HOME, process.env.CODEX_HOME);
    assert.equal(
      child.CODEX_PERMISSION_PROFILE,
      process.env.CODEX_PERMISSION_PROFILE,
    );
  } finally {
    keys.forEach((key, index) => {
      if (before[index] === undefined) delete process.env[key];
      else process.env[key] = before[index];
    });
  }
});
