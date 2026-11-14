// Continues the isolated onboarding QA. Never attaches to the demo profile.
import { chromium, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { verifySpeechCapture } from "./speech-capture-check.mjs";

const fixture = JSON.parse(
  await readFile("../tmp/memcode-onboarding/results.json", "utf8"),
);
if (fixture.port === 9329 || !fixture.profile.includes("memcode-onboarding-"))
  throw Error("This check requires its isolated onboarding QA profile.");
const browser = await chromium.connectOverCDP(
  "http://127.0.0.1:" + fixture.port,
);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url().includes("tauri.localhost"));
if (!page) throw Error("QA main page unavailable");
const click = (locator) => locator.evaluate((element) => element.click());
await click(page.getByRole("button", { name: "Settings", exact: true }));
await click(
  page.getByRole("button", { name: "Set up local dictation", exact: true }),
);
await expect(page.getByText("Ready to dictate", { exact: true })).toBeVisible({
  timeout: 60000,
});
await page.screenshot({
  path: "../tmp/memcode-onboarding/dictation.png",
  animations: "disabled",
});
await click(page.getByRole("button", { name: "Save settings", exact: true }));
await click(
  page
    .getByText("Add a welcoming project introduction.", { exact: true })
    .first(),
);
await expect(
  page.getByRole("textbox", { name: "Message to worker", exact: true }),
).toBeVisible();
const result = await verifySpeechCapture(
  page,
  "../tmp/memcode-speech-evidence/jfk.wav",
);
await writeFile(
  "../tmp/memcode-onboarding/speech-native.json",
  JSON.stringify(result, null, 2),
);
await page.screenshot({
  path: "../tmp/memcode-onboarding/speech-draft.png",
  animations: "disabled",
});
await page
  .getByRole("textbox", { name: "Message to worker", exact: true })
  .fill("");
await click(page.getByRole("button", { name: "Close work item", exact: true }));
console.log(JSON.stringify(result));
process.exit(0);
