import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { startTeamRelay } from "../runtime/team/relay.ts";

const directory = await mkdtemp(join(tmpdir(), "memcode-team-landing-"));
const output = resolve(".memcode/verification/team-landing");
await mkdir(output, { recursive: true });
const relay = await startTeamRelay({ dataDir: directory, port: 0 });
const browser = await chromium.launch({
  headless: true,
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
});
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const token = "fixture-only-invitation-" + "x".repeat(32),
    url = relay.url + "/join/team/fixture-team#invite=" + token;
  await page.goto(url);
  await page.getByRole("heading", { name: /Your team/ }).waitFor();
  await page
    .getByRole("button", { name: "Copy invitation", exact: true })
    .click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), url);
  assert.equal(
    await page.getByRole("button", { name: "Copied", exact: true }).count(),
    1,
  );
  await page.screenshot({ path: join(output, "desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(output, "mobile.png"), fullPage: true });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.goto(relay.url + "/join/team/incomplete");
  await page.getByText("This link is incomplete.", { exact: false }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Copy invitation", exact: true })
      .isDisabled(),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Team landing: desktop/mobile, CSP script, clipboard, incomplete-link state passed.",
  );
} finally {
  await browser.close();
  await relay.close();
  await rm(directory, { recursive: true, force: true });
}
