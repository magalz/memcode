import { _electron as electron } from "@playwright/test";
import electronPath from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(".");
const out = resolve("../tmp/memcode-review");
await mkdir(out, { recursive: true });
const env = {
  ...process.env,
  MEMCODE_DATA_DIR: resolve(tmpdir(), "memcode-visual-review-v2"),
};
delete env.ELECTRON_RUN_AS_NODE;
const desktop = await electron.launch({
  executablePath: electronPath,
  args: [root],
  env,
  timeout: 30000,
});
try {
  desktop.process().stderr.on("data", (data) => {
    const text = String(data);
    if (/error|failed|fatal/i.test(text)) console.error(text.slice(0, 2000));
  });
  const page = await desktop.firstWindow();
  page.on("pageerror", (error) => console.error("RENDERER:", error.message));
  await page.waitForSelector(".work-board", { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(200);
  await page.screenshot({ path: out + "/01-workspace.png" });
  console.log(
    "WINDOW",
    await page.title(),
    await page.locator(".work-card").count(),
  );
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await page.screenshot({ path: out + "/02-list.png" });
  await page.getByRole("button", { name: "Board view", exact: true }).click();
  await page
    .getByRole("button", { name: "MC-013: Shape the worker workspace" })
    .click();
  await page.screenshot({ path: out + "/03-conversation.png" });
  await page.getByRole("button", { name: "Runbook", exact: true }).click();
  await page.screenshot({ path: out + "/04-runbook.png" });
  await page
    .getByRole("button", { name: "Close work item", exact: true })
    .click();
  await page.locator(".nav-item").filter({ hasText: "Artifacts" }).click();
  await page.screenshot({ path: out + "/05-artifacts.png" });
  await page.getByRole("button", { name: /workspace-preview.html/ }).click();
  await page
    .locator(".detail-tabs button")
    .filter({ hasText: "Artifacts" })
    .click();
  await page
    .getByRole("button", { name: /workspace-preview.html/ })
    .last()
    .click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: out + "/06-browser-shell.png" });
  const guest = await desktop.evaluate(async ({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find(
      (item) =>
        item.webContents && item.webContents.getURL().includes("/examples/"),
    );
    if (!view) return null;
    return {
      url: view.webContents.getURL(),
      bridge: await view.webContents.executeJavaScript("typeof window.memcode"),
      image: (await view.webContents.capturePage()).toPNG().toString("base64"),
    };
  });
  if (guest) {
    await writeFile(
      out + "/07-browser-content.png",
      Buffer.from(guest.image, "base64"),
    );
    console.log("PREVIEW", { url: guest.url, bridge: guest.bridge });
  }
  await page
    .getByRole("button", { name: "Close work item", exact: true })
    .click();
  await page
    .getByRole("button", { name: /Settings/ })
    .first()
    .click();
  await page.screenshot({ path: out + "/08-settings.png" });
  console.log("Review screenshots:", out);
} finally {
  await desktop.close();
}
