// Isolated renderer fixture. No real Memtrace session or user window is touched.
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, ".memcode", "verification", "account-ui");
await mkdir(output, { recursive: true });
await build({
  stdin: { loader: "tsx", resolveDir: root, sourcefile: "account-fixture.tsx", contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {AccountConnections} from './src/components/AccountConnections';
import './src/styles.css';
const query=new URLSearchParams(location.search),mode=query.get('mode');
const connected={status:'connected',label:'Memtrace connected',detail:'Using the installed CLI session.',loginPending:false,authMode:'session'};
let current=mode==='environment'?{...connected,authMode:'environment',managedBy:['MEMTRACE_LICENSE_KEY']}:mode==='unavailable'?{...connected,status:'unavailable',label:'Memtrace not found'}:connected;
window.calls=[];window.holdStatus=false;
const signedOut=()=>({status:'needs-sign-in',label:'Memtrace signed out',detail:'Sign in to continue.',loginPending:false,signedOut:true,reconnectRequired:true,authMode:'session'});
const pending=()=>({...signedOut(),signedOut:false,label:'Waiting for Memtrace',loginPending:true,sessionAction:'signing-in',claimUrl:'https://www.memtrace.io/claim?code=fixture-only-code'});
window.memcode={
 accountStatus:async()=>{window.calls.push('status');if(window.holdStatus)return await new Promise(resolve=>{window.releaseStatus=()=>resolve(connected)});return current},
 signOutMemtrace:async()=>{window.calls.push('sign-out');if(mode==='active')throw Error('Stop active workers before changing accounts.');return current=signedOut()},
 switchMemtraceAccount:async()=>{window.calls.push('switch');return current=pending()},
 signInMemtrace:async()=>{window.calls.push('sign-in');return current=pending()},
 cancelMemtraceSignIn:async()=>{window.calls.push('cancel');return current=signedOut()},
};
const notify=text=>window.calls.push(['notify',text]);
createRoot(document.getElementById('root')).render(<main style={{maxWidth:720,padding:28,margin:'0 auto'}}><h1>Account settings</h1><AccountConnections compact={query.has('compact')} notify={notify}/></main>);
` },
  absWorkingDir: root, bundle: true, outdir: output, entryNames: "fixture",
  format: "esm", jsx: "automatic", loader: { ".woff2": "file", ".woff": "file" },
});
await writeFile(join(output, "index.html"), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
const server = createServer(async (request, response) => {
  try {
    const name = basename(new URL(request.url, "http://localhost").pathname) || "index.html";
    response.setHeader("content-type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html");
    response.end(await readFile(join(output, name)));
  } catch { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
  const page = await browser.newPage({ viewport: { width: 1050, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(url);
  await expect(page.getByText("Memtrace connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Switch account", exact: true }).click();
  const confirmation = page.getByRole("group", { name: "Confirm account change" });
  await expect(confirmation).toContainText("Team preview membership");
  expect(await page.evaluate(() => window.calls.includes("switch"))).toBe(false);
  await confirmation.getByRole("button", { name: "Keep current account" }).click();
  await expect(confirmation).toHaveCount(0);
  await page.getByRole("button", { name: "Switch account", exact: true }).click();
  await page.screenshot({ path: join(output, "switch-confirmation.png") });
  await confirmation.getByRole("button", { name: "Continue to sign in" }).click();
  await expect(page.getByRole("button", { name: "Cancel sign-in" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy sign-in link" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel sign-in" }).click();
  await expect(page.getByText("Memtrace signed out", { exact: true })).toBeVisible();
  await expect(page.getByText(/Restart MemCode before starting workers/)).toBeVisible();
  await page.getByRole("button", { name: "Sign in with Memtrace" }).click();
  await page.getByRole("button", { name: "Cancel sign-in" }).click();
  expect(await page.evaluate(() => window.calls.filter(x => x === "cancel").length)).toBe(2);
  await page.goto(url);
  await expect(page.getByText("Memtrace connected", { exact: true })).toBeVisible();
  await page.evaluate(() => { window.holdStatus = true; });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof window.releaseStatus)).toBe("function");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await confirmation.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByText("Memtrace signed out", { exact: true })).toBeVisible();
  await page.evaluate(() => window.releaseStatus());
  await page.waitForTimeout(100);
  await expect(page.getByText("Memtrace signed out", { exact: true })).toBeVisible();
  await page.goto(url + "/?mode=environment");
  await expect(page.getByRole("button", { name: "Switch account", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeDisabled();
  await expect(page.getByText("MEMTRACE_LICENSE_KEY", { exact: true })).toBeVisible();
  await page.goto(url + "/?mode=active");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await confirmation.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.calls.some(x => Array.isArray(x) && String(x[1]).includes("Stop active workers")))).toBe(true);
  await expect(page.getByText("Memtrace connected", { exact: true })).toBeVisible();
  await page.goto(url + "/?mode=unavailable");
  await expect(page.getByRole("button", { name: "Sign in with Memtrace" })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 820 });
  await page.goto(url + "/?compact");
  await page.getByRole("button", { name: "Memtrace account", exact: true }).click();
  await page.getByRole("button", { name: "Switch account", exact: true }).click();
  await expect(confirmation.getByRole("button", { name: "Continue to sign in" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(output, "compact-switch.png"), fullPage: true });
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, flows: ["explicit switch confirmation", "keep account", "switch to browser login", "cancel login", "sign in again", "sign out", "stale refresh isolation", "environment managed", "active worker error", "missing CLI", "compact responsive layout"], screenshotDirectory: output }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
