// Synthetic renderer checks. No native app, provider, account or worker is used.
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, ".memcode", "verification", "platform");
await mkdir(output, { recursive: true });
await build({
  stdin: {
    loader: "tsx",
    resolveDir: root,
    sourcefile: "platform-fixture.tsx",
    contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './src/App';
import {WorkDetail} from './src/components/WorkDetail';
import {ReviewComposer} from './src/components/ReviewComposer';
import {initialState} from './src/seed';
import './src/styles.css';
const state=initialState();
const project={id:'platform-fixture',name:'Platform fixture',description:'Synthetic keyboard verification',path:null,branch:'main',analysis:'idle',example:true,createdAt:'2026-11-16'};
const task={...state.tasks[0],id:'keyboard-story',projectId:project.id,title:'Synthetic keyboard story',description:'Verify native shortcut conventions.',stage:'planned',example:true,messages:[],route:undefined};
Object.assign(state,{activeProjectId:project.id,projects:[project],tasks:[task],epics:[],cycles:[],artifacts:[],onboarding:{version:1,step:'ready',dismissed:true}});
const runtime={appVersion:'synthetic',harnesses:[],memtraceAvailable:false,dataPath:'synthetic'};
window.calls=[];
window.memcode=new Proxy({
 load:async()=>({state,runtime}),
 accountStatus:async()=>({status:'needs-sign-in',label:'Synthetic account fixture',detail:'No live account',loginPending:false}),
 onState:()=>()=>{},
 sendFollowup:async(...args)=>{window.calls.push(['followup',...args]);return{messageId:'fixture-message'}},
}, {get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>[]});
const mode=new URLSearchParams(location.search).get('mode');
const ref={taskId:task.id,kind:'text',source:'file',path:'notes.md',quote:'A selected sentence',version:'fixture'};
const node=mode==='review'?<ReviewComposer references={[ref]} onRemove={()=>{}} onClose={()=>{}} onSave={async(text)=>{window.calls.push(['review',text])}}/>:mode==='story'?<WorkDetail state={state} task={task} project={project} artifacts={[]} runtime={runtime} epics={[]} conflicts={[]} tasks={[task]} onDecisions={()=>{}} onConnections={()=>{}} onClose={()=>{}} onOpenTask={()=>{}} onCreateChild={()=>{}} notify={()=>{}} act={async(action)=>action()}/>:<App/>;
createRoot(document.getElementById('root')).render(<><div style={{position:'fixed',right:12,bottom:8,zIndex:99999,fontSize:10,pointerEvents:'none'}}>Synthetic platform fixture · no live worker</div>{node}</>);
`,
  },
  bundle: true,
  absWorkingDir: root,
  outdir: output,
  entryNames: "fixture",
  define: { "import.meta.env.DEV": "false" },
  format: "esm",
  jsx: "automatic",
  loader: { ".woff2": "file", ".woff": "file" },
  plugins: [
    {
      name: "unused-vite-worker-url",
      setup(builder) {
        builder.onResolve({ filter: /\?url$/ }, (args) => ({
          path: args.path,
          namespace: "fixture-url",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture-url" }, () => ({
          contents: 'export default "/synthetic-unused-worker.mjs";',
          loader: "js",
        }));
      },
    },
  ],
});
await writeFile(
  join(output, "index.html"),
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
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
          : "text/html",
    );
    response.end(await readFile(join(output, name)));
  } catch {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const errors = [];
const results = [];
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  for (const platform of ["MacIntel", "Win32", "Linux x86_64"]) {
    const mac = platform === "MacIntel";
    const key = mac ? "Meta" : "Control";
    const wrong = mac ? "Control" : "Meta";
    const label = mac ? "⌘" : "Ctrl";
    const context = await browser.newContext({
      viewport: { width: 1280, height: 960 },
    });
    await context.addInitScript((value) => {
      Object.defineProperty(navigator, "platform", { get: () => value });
      Object.defineProperty(navigator, "userAgentData", {
        get: () => undefined,
      });
    }, platform);
    const page = await context.newPage();
    page.on("pageerror", (error) =>
      errors.push({ platform, message: error.message }),
    );
    await page.goto(url);
    const search = page.getByRole("button", { name: /^Search anything/ });
    await expect(search).toContainText(`${label}+K`);
    await page.keyboard.press(`${wrong}+k`);
    await expect(page.locator(".modal-backdrop")).toHaveCount(0);
    await page.keyboard.press(`${key}+k`);
    await expect(page.locator(".modal-backdrop")).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: join(
        output,
        `${mac ? "macos" : platform === "Win32" ? "windows" : "linux"}-search.png`,
      ),
    });
    await page.goto(`${url}?mode=story`);
    const draft = page.getByRole("textbox", {
      name: "Message to worker",
      exact: true,
    });
    await expect(draft).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send follow-up", exact: true }),
    ).toHaveAttribute("title", `Send follow-up · ${label}+Enter`);
    await draft.fill("Synthetic follow-up");
    await draft.press(`${wrong}+Enter`);
    expect(
      await page.evaluate(
        () => window.calls.filter((call) => call[0] === "followup").length,
      ),
    ).toBe(0);
    await draft.press(`${key}+Enter`);
    await expect
      .poll(() =>
        page.evaluate(
          () => window.calls.filter((call) => call[0] === "followup").length,
        ),
      )
      .toBe(1);
    await page.goto(`${url}?mode=review`);
    const comment = page.getByRole("textbox");
    await comment.fill("Keep this as a saved review comment");
    await comment.press(`${wrong}+Enter`);
    expect(await page.evaluate(() => window.calls.length)).toBe(0);
    await comment.press(`${key}+Enter`);
    await expect
      .poll(() =>
        page.evaluate(
          () => window.calls.filter((call) => call[0] === "review").length,
        ),
      )
      .toBe(1);
    expect(
      await page.evaluate(() =>
        window.calls.some((call) => call[0] === "followup"),
      ),
    ).toBe(false);
    results.push({
      platform,
      search: true,
      followup: true,
      savedReviewOnly: true,
    });
    await context.close();
  }
  expect(errors).toEqual([]);
  await writeFile(
    join(output, "evidence.json"),
    JSON.stringify({ fixture: "synthetic", results, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: results.length * 3, results, errors }));
} catch (error) {
  const page = browser?.contexts().at(-1)?.pages().at(-1);
  if (page) {
    await page.screenshot({ path: join(output, "failure.png") });
    console.log(
      JSON.stringify({
        errors,
        body: (await page.locator("body").innerText()).slice(0, 1800),
      }),
    );
  }
  throw error;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
