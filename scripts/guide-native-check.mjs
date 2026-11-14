import { chromium, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { guideArticles } from "../src/guide-content.ts";

const fixture = JSON.parse(
  await readFile("../tmp/memcode-onboarding/results.json", "utf8"),
);
if (fixture.port === 9329 || !fixture.profile.includes("memcode-onboarding-"))
  throw Error("Guide verification requires its isolated onboarding profile.");
const browser = await chromium.connectOverCDP(
  "http://127.0.0.1:" + fixture.port,
);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url().includes("tauri.localhost"));
await page
  .getByRole("button", { name: "Docs", exact: true })
  .evaluate((button) => button.click());
const loaded = [];
for (const article of guideArticles) {
  await page
    .locator(".docs-index")
    .getByRole("button", { name: article.title, exact: true })
    .evaluate((button) => button.click());
  await expect(page.locator(".docs-article > h2")).toHaveText(article.title);
  if (article.id === "start") continue;
  const image = page.locator(".docs-figure img");
  await expect(image).toHaveAttribute(
    "src",
    "/guide/" + article.image + ".png",
  );
  await expect
    .poll(() =>
      image.evaluate((image) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true);
  loaded.push(article.id);
}
await page
  .locator(".docs-index")
  .getByRole("button", { name: guideArticles[0].title, exact: true })
  .evaluate((button) => button.click());
await page.screenshot({
  path: "../tmp/memcode-onboarding/docs-final.png",
  animations: "disabled",
});
const report = {
  result: "passed",
  articles: guideArticles.length,
  illustratedArticles: loaded.length,
  uniqueImages: new Set(
    guideArticles
      .filter((article) => article.id !== "start")
      .map((article) => article.image),
  ).size,
};
await writeFile(
  "../tmp/memcode-onboarding/guide-native.json",
  JSON.stringify(report, null, 2),
);
await page.evaluate(() => window.memcode.windowAction("close"));
console.log(JSON.stringify(report));
process.exit(0);
