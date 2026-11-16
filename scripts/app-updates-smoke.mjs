import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  output = join(root, ".memcode/verification/app-updates");
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root,
  bundle: true,
  outdir: output,
  entryNames: "fixture",
  format: "esm",
  jsx: "automatic",
  loader: { ".woff2": "file", ".woff": "file" },
  stdin: {
    loader: "tsx",
    resolveDir: root,
    sourcefile: "app-updates-fixture.tsx",
    contents: `
import React from 'react';import{createRoot}from'react-dom/client';import{AppUpdates}from'./src/components/AppUpdates';import{AppUpdater}from'./src/updates';import'./src/styles.css';import'@fontsource-variable/inter';
const mode=new URLSearchParams(location.search).get('mode');window.calls=[];window.activeWorkers=2;window.malicious=false;
const release={version:'0.4.0-beta.2',notes:'## A calmer workspace\\n\\n- Smoother worker updates.\\n- Clearer review and follow-up queues.\\n\\nCode stays on your machine.\\n\\n![Remote image](https://example.invalid/never-load.png)\\n<script>window.malicious=true</script>',publishedAt:'2026-11-16T12:00:00Z'};
const updater=new AppUpdater({info:async()=>{if(mode==='legacy')throw Error('Command app_update_info not found');return{currentVersion:'0.4.0-beta.1',development:mode==='development'}},context:async()=>({activeWorkers:window.activeWorkers,activeTerminals:3}),check:async()=>{window.calls.push('check');if(mode==='offline')throw Error('The update service is unreachable.');return mode==='current'?null:release},history:async()=>{window.calls.push('history');return[{...release,title:'A calmer workspace'},{version:'0.4.0-beta.1',title:'First beta',notes:'The first signed release.',publishedAt:'2026-11-15T12:00:00Z'}]},install:async(version,progress)=>{window.calls.push(['install',version]);progress({phase:'downloading',downloaded:55,total:100});await new Promise(resolve=>window.finishInstall=resolve);progress({phase:'installing',downloaded:100,total:100});}});
createRoot(document.getElementById('root')).render(<main style={{maxWidth:690,margin:'35px auto',padding:30,border:'1px solid #dce5d9',borderRadius:14,background:'#fbfdfb'}}><div className="kicker">MEMCODE / SETTINGS</div><h1 style={{fontSize:25,letterSpacing:'-.04em',marginBottom:25}}>Make the workspace yours.</h1><form onSubmit={event=>{event.preventDefault();window.calls.push('submit')}}><AppUpdates currentVersion="0.4.0-beta.1" updater={updater}/></form></main>);
`,
  },
});
await writeFile(
  join(output, "index.html"),
  '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
);
const server = createServer(async (request, response) => {
  try {
    const name =
      basename(new URL(request.url, "http://localhost").pathname) ||
      "index.html";
    response.setHeader(
      "content-type",
      name.endsWith(".js")
        ? "text/javascript"
        : name.endsWith(".css")
          ? "text/css"
          : name.endsWith(".woff2")
            ? "font/woff2"
            : "text/html",
    );
    response.end(await readFile(join(output, name)));
  } catch {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  const page = await browser.newPage({
      viewport: { width: 1050, height: 1000 },
    }),
    errors = [];
  let externalRequests = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://example.invalid/**", (route) => {
    externalRequests++;
    void route.abort();
  });
  const url = "http://127.0.0.1:" + server.address().port;
  await page.goto(url);
  await expect(
    page.getByRole("button", { name: "Check for updates", exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => window.calls)).toEqual([]);
  await page
    .getByRole("button", { name: "Check for updates", exact: true })
    .click();
  await expect(
    page.getByText("Version 0.4.0-beta.2 is available.", { exact: true }),
  ).toBeVisible();
  await page.getByText("Recent updates", { exact: true }).click();
  await expect(page.getByText("First beta", { exact: true })).toBeVisible();
  await page.screenshot({
    path: join(output, "available-release.png"),
    fullPage: true,
  });
  expect(await page.evaluate(() => window.malicious)).toBe(false);
  expect(externalRequests).toBe(0);
  await page
    .getByRole("button", { name: "Update MemCode", exact: true })
    .click();
  await expect(page.getByText(/2 workers are still running/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Install and restart", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: join(output, "active-workers.png"),
    fullPage: true,
  });
  await page.evaluate(() => (window.activeWorkers = 0));
  await page.getByRole("button", { name: "Refresh update readiness" }).click();
  await expect(
    page.getByText(/Restarting closes 3 terminal sessions/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  expect(
    await page.evaluate(() =>
      window.calls.some((call) => Array.isArray(call) && call[0] === "install"),
    ),
  ).toBe(false);
  await page
    .getByRole("button", { name: "Update MemCode", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Install and restart", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: join(output, "restart-confirmation.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Install and restart", exact: true })
    .click();
  await expect(
    page.getByRole("progressbar", { name: "Update download" }),
  ).toHaveAttribute("aria-valuenow", "55");
  await page.screenshot({
    path: join(output, "downloading.png"),
    fullPage: true,
  });
  await page.evaluate(() => window.finishInstall());
  await expect(
    page.getByText("Installing and restarting MemCode…", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("v0.4.0-beta.1", { exact: true }).first(),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        window.calls.filter(
          (call) => Array.isArray(call) && call[0] === "install",
        ).length,
    ),
  ).toBe(1);
  expect(await page.evaluate(() => window.calls.includes("submit"))).toBe(
    false,
  );
  await page.goto(url + "?mode=offline");
  await page
    .getByRole("button", { name: "Check for updates", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("unreachable");
  await expect(
    page.getByText("You’re up to date.", { exact: true }),
  ).toHaveCount(0);
  await page.goto(url + "?mode=current");
  await page
    .getByRole("button", { name: "Check for updates", exact: true })
    .click();
  await expect(
    page.getByText("You’re up to date.", { exact: true }),
  ).toBeVisible();
  await page.goto(url + "?mode=development");
  await expect(
    page.getByText("Development build", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check for updates", exact: true }),
  ).toHaveCount(0);
  await page.goto(url + "?mode=legacy");
  await expect(page.getByRole("alert")).toContainText(
    "Restart MemCode to load app-update support",
  );
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({
      passed: 9,
      screenshots: output,
      nativeInstallPerformed: false,
      note: "Isolated rendered Settings fixture; actual updater signature verification is exercised separately in Rust.",
    }),
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
