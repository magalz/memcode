import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  macReleasePolicy,
  assertPublicMacTrust,
} from "../scripts/macos-release-trust.mjs";

const configured = () => ({
  APPLE_CERTIFICATE: "test-certificate-placeholder",
  APPLE_CERTIFICATE_PASSWORD: "test-password-placeholder",
  APPLE_SIGNING_IDENTITY: "Developer ID Application: Example (ABCDEFGHIJ)",
  APPLE_TEAM_ID: "ABCDEFGHIJ",
  APPLE_ID: "test@example.invalid",
  APPLE_PASSWORD: "app-specific-test-placeholder",
});

test("macOS public packaging fails closed instead of silently producing ad-hoc downloads", () => {
  assert.throws(() => macReleasePolicy({}), /APPLE_CERTIFICATE/);
  assert.throws(
    () => macReleasePolicy({ MEMCODE_MACOS_RELEASE_MODE: "unknown" }),
    /Choose/,
  );
  assert.equal(
    macReleasePolicy({ MEMCODE_MACOS_RELEASE_MODE: "private-candidate" })
      .publicReady,
    false,
  );
  const beta = macReleasePolicy({
    MEMCODE_MACOS_RELEASE_MODE: "manual-approval-beta",
  });
  assert.equal(beta.publicReady, false);
  assert.equal(beta.manualApprovalRequired, true);
  assert.equal(beta.betaDistributionAllowed, true);
  assert.equal(macReleasePolicy(configured()).mode, "public-release");
  assert.equal(macReleasePolicy(configured()).publicReady, false);
});

test("public packaging rejects ad-hoc identity, wrong team and incomplete notarization credentials", () => {
  assert.throws(
    () => macReleasePolicy({ ...configured(), APPLE_SIGNING_IDENTITY: "-" }),
    /Developer ID/,
  );
  assert.throws(
    () => macReleasePolicy({ ...configured(), APPLE_TEAM_ID: "ZZZZZZZZZZ" }),
    /must match/,
  );
  assert.throws(
    () => macReleasePolicy({ ...configured(), APPLE_PASSWORD: "" }),
    /complete notarization/,
  );
  assert.throws(
    () => macReleasePolicy({ ...configured(), APPLE_API_KEY: "partial" }),
    /incomplete/,
  );
  assert.throws(
    () =>
      macReleasePolicy({
        ...configured(),
        TAURI_SKIP_SIDECAR_SIGNATURE_CHECK: "true",
      }),
    /cannot skip/,
  );
});

test("complete API key configuration is accepted without an Apple ID password", () => {
  const env = {
    ...configured(),
    APPLE_ID: "",
    APPLE_PASSWORD: "",
    APPLE_API_KEY: "KEYID",
    APPLE_API_ISSUER: "issuer",
    APPLE_API_KEY_P8: "test-key-placeholder",
  };
  assert.equal(macReleasePolicy(env).authentication, "api-key");
});

test("an updater signature alone cannot qualify a Mac candidate as trusted", () => {
  assert.throws(
    () =>
      assertPublicMacTrust({
        updaterSignatureVerified: true,
        mode: "private-candidate",
      }),
    /not approved/,
  );
  assert.throws(
    () =>
      assertPublicMacTrust({
        updaterSignatureVerified: true,
        mode: "manual-approval-beta",
        manualApprovalRequired: true,
        betaDistributionAllowed: true,
      }),
    /not approved/,
  );
  const complete = {
    mode: "public-release",
    publicReady: true,
    developerIdSigned: true,
    notarized: true,
    appGatekeeper: "accepted",
    dmgGatekeeper: "accepted",
    appTicket: "validated",
    dmgTicket: "validated",
    updaterAppTicket: "validated",
    updaterAppGatekeeper: "accepted",
    signedNodeJitSmoke: "passed",
    dmgLayoutVerified: true,
    teamId: "ABCDEFGHIJ",
    nestedMachOCount: 2,
    bundledEngineNativeTrust: { developerIdSigned: true, gatekeeper: "accepted", nativeExecutables: 4 },
  };
  assert.equal(assertPublicMacTrust(complete), complete);
  for (const key of [
    "developerIdSigned",
    "notarized",
    "appTicket",
    "dmgTicket",
    "updaterAppTicket",
    "updaterAppGatekeeper",
    "appGatekeeper",
    "dmgGatekeeper",
    "dmgLayoutVerified",
    "signedNodeJitSmoke",
    "bundledEngineNativeTrust",
  ]) {
    assert.throws(
      () => assertPublicMacTrust({ ...complete, [key]: undefined }),
      /not approved/,
    );
  }
  assert.throws(() => assertPublicMacTrust({ ...complete, bundledEngineNativeTrust: { developerIdSigned: false, gatekeeper: "accepted", nativeExecutables: 4 } }), /not approved/);
  assert.throws(() => assertPublicMacTrust({ ...complete, bundledEngineNativeTrust: { developerIdSigned: true, gatekeeper: "not-established", nativeExecutables: 4 } }), /not approved/);
});

test("the installer background is genuinely 2x at the configured logical size", async () => {
  const png = await readFile(
    new URL("../src-tauri/dmg-background.png", import.meta.url),
  );
  assert.equal(png.readUInt32BE(16), 1440);
  assert.equal(png.readUInt32BE(20), 960);
  let physical: { x: number; y: number; unit: number } | undefined;
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset),
      type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "pHYs")
      physical = {
        x: png.readUInt32BE(offset + 8),
        y: png.readUInt32BE(offset + 12),
        unit: png[offset + 16],
      };
    offset += length + 12;
  }
  assert.deepEqual(physical, { x: 5669, y: 5669, unit: 1 });
  const config = JSON.parse(
    await readFile(
      new URL("../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(config.bundle.macOS.dmg.windowSize, {
    width: 720,
    height: 508,
  });
});
