import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { startCodexSession } from "../runtime/agents/codex";
import type { AgentEvent, AgentSessionOptions } from "../runtime/agents/types";
import type {
  WorkerInputPrompt,
  WorkerInputResponse,
} from "../src/worker-input";

const fixture = `
import { createInterface } from 'node:readline';
const rl=createInterface({input:process.stdin});
const send=p=>process.stdout.write(JSON.stringify(p)+'\\n');
const notify=(method,params)=>send({method,params});
let index=0,initialized=false,threadSettings,turnSettings; const replies=[];
const requests=JSON.parse(process.env.REQUESTS||'[]');
function next(){
 if(index<requests.length){const r=requests[index++]; send({id:r.id,method:r.method,params:{threadId:'thread-native',turnId:'turn-native',...r.params}});}
 else if(process.env.WAIT!=='yes'){
  notify('item/agentMessage/delta',{threadId:'thread-native',itemId:'final',delta:'Done'});
  notify('item/completed',{threadId:'thread-native',item:{type:'agentMessage',id:'final',text:'Done'}});
  notify('item/completed',{threadId:'thread-native',item:{type:'agentMessage',id:'evidence',text:JSON.stringify({replies,args:process.argv.slice(2),threadSettings,turnSettings})}});
  notify('turn/completed',{threadId:'thread-native',turn:{id:'turn-native',status:process.env.FAIL==='yes'?'failed':'completed',error:process.env.FAIL==='yes'?{message:'Native failure'}:null}});
 }
}
rl.on('line',line=>{const p=JSON.parse(line);
 if(p.method==='initialize'){
  if(process.env.INIT_FAIL==='yes'){send({id:p.id,error:{code:-32603,message:'Initialization rejected'}});return;}
  if(p.params.capabilities.requiredHumanApproval!==true)process.exit(11);
  send({id:p.id,result:{userAgent:'fixture'}});
 }else if(p.method==='initialized')initialized=true;
 else if(p.method==='thread/start'){
  threadSettings=p.params;
  const full=process.env.MODE==='full-access';
  if(!initialized||p.params.approvalPolicy!==(full?'never':'on-request')||p.params.sandbox!==(full?'danger-full-access':'workspace-write')||p.params.approvalsReviewer!==(process.env.MODE==='auto'?'auto_review':'user')||p.params.allowProviderModelFallback!==false||p.params.model!=='chosen-model')process.exit(12);
  send({id:p.id,result:{thread:{id:'thread-native'},approvalPolicy:p.params.approvalPolicy,approvalsReviewer:process.env.DOWNGRADE==='yes'?'user':p.params.approvalsReviewer,sandbox:{type:full?'dangerFullAccess':'workspaceWrite'}}});
 }else if(p.method==='turn/start'){
  turnSettings=p.params;
  if(p.params.effort!=='high'||p.params.input[0].text!=='The exact prompt')process.exit(13);
  send({id:p.id,result:{turn:{id:'turn-native',status:'inProgress'}}});
  notify('item/started',{threadId:'thread-native',item:{id:'tool-1',type:'commandExecution',command:'npm test'}});
  notify('turn/plan/updated',{threadId:'thread-native',plan:[{step:'Check the code',status:'inProgress'}]});
  if(process.env.MALFORMED==='yes')process.stdout.write('{bad json\\n'); else next();
 }else if(p.method==='turn/interrupt')send({id:p.id,result:{}});
 else if(p.id!==undefined){replies.push(p);next();}
});
`;

async function runFixture(
  env: Record<string, string> = {},
  respond: (
    prompt: WorkerInputPrompt,
    signal?: AbortSignal,
  ) => Promise<WorkerInputResponse> = async () => ({ cancelled: true }),
) {
  const dir = await mkdtemp(join(tmpdir(), "memcode-codex-protocol-"));
  const script = join(dir, "server.mjs");
  await writeFile(script, fixture);
  const events: AgentEvent[] = [],
    prompts: WorkerInputPrompt[] = [];
  const options: AgentSessionOptions = {
    command: { command: process.execPath, prefix: [script] },
    cwd: dir,
    env: { ...process.env, ...env },
    model: "chosen-model",
    effort: "high",
    prompt: "The exact prompt",
    briefPath: "brief.md",
    toolArgs: [
      "-c",
      "mcp_servers.memcode_context={enabled=true,required=true}",
      "-c",
      "approval_policy=never",
      "--config=approvals_reviewer=guardian_subagent",
      "-c",
      "sandbox_mode=danger-full-access",
    ],
    permissionMode: env.MODE as AgentSessionOptions["permissionMode"],
    onEvent: (event) => events.push(event),
    requestInput: async (prompt, signal) => {
      prompts.push(prompt);
      return respond(prompt, signal);
    },
  };
  const session = startCodexSession(options);
  const close = once(session.child, "close");
  return {
    session,
    events,
    prompts,
    async cleanup() {
      session.stop();
      await close;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const evidence = (events: AgentEvent[]) => {
  const item = events.find(
    (event) => event.type === "message" && event.messageId === "evidence",
  );
  assert.ok(item?.type === "message");
  return JSON.parse(item.text);
};

test("Codex native turn preserves model, policy, effort, MCP config and finishes before server exit", async () => {
  const f = await runFixture();
  try {
    assert.equal((await f.session.completion).exitCode, 0);
    const result = evidence(f.events);
    assert.equal(
      f.events.filter((event) => event.type === "prompted").length,
      1,
    );
    assert.ok(
      f.events.findIndex((event) => event.type === "prompted") >
        f.events.findIndex((event) => event.type === "session"),
    );
    assert.ok(
      result.args.includes("features.default_mode_request_user_input=true"),
    );
    assert.ok(
      result.args.includes(
        "mcp_servers.memcode_context={enabled=true,required=true}",
      ),
    );
    assert.ok(
      f.events.some(
        (event) =>
          event.type === "session" && event.sessionId === "thread-native",
      ),
    );
    assert.ok(
      f.events.some(
        (event) => event.type === "activity" && event.label === "npm test",
      ),
    );
    assert.ok(
      f.events.some(
        (event) =>
          event.type === "message" && event.text.includes("Check the code"),
      ),
    );
    assert.equal(
      f.events.filter(
        (event) => event.type === "message" && event.messageId === "final",
      ).length,
      1,
    );
    assert.equal(
      f.prompts.length,
      0,
      "native plan notification must not invent an approval",
    );
  } finally {
    await f.cleanup();
  }
});

for (const mode of ["review", "auto", "full-access"] as const)
  test(`Codex uses explicit ${mode} settings and keeps inherited arguments from overriding them`, async () => {
    const f = await runFixture({ MODE: mode });
    try {
      assert.equal((await f.session.completion).exitCode, 0);
      const result = evidence(f.events);
      assert.equal(
        result.threadSettings.approvalPolicy,
        mode === "full-access" ? "never" : "on-request",
      );
      assert.equal(
        result.threadSettings.sandbox,
        mode === "full-access" ? "danger-full-access" : "workspace-write",
      );
      assert.equal(
        result.threadSettings.approvalsReviewer,
        mode === "auto" ? "auto_review" : "user",
      );
      assert.equal(
        result.turnSettings.approvalsReviewer,
        result.threadSettings.approvalsReviewer,
      );
      assert.ok(
        !result.args.some((arg: string) =>
          /^(approval_policy|sandbox_mode)=|^--config=approvals_reviewer=/.test(
            arg,
          ),
        ),
      );
    } finally {
      await f.cleanup();
    }
  });

test("Codex refuses a silent downgrade of the selected automatic reviewer before prompting the model", async () => {
  const f = await runFixture({ MODE: "auto", DOWNGRADE: "yes" });
  try {
    const result = await f.session.completion;
    assert.match(result.error ?? "", /did not activate the selected auto/);
    assert.equal(
      f.events.some((event) => event.type === "prompted"),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test("Codex setup failure never marks queued context as sent to the model", async () => {
  const f = await runFixture({ INIT_FAIL: "yes" });
  try {
    const result = await f.session.completion;
    assert.equal(result.exitCode, 1);
    assert.match(result.error || "", /Initialization rejected/);
    assert.equal(
      f.events.filter((event) => event.type === "prompted").length,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test("Codex command/file approvals return exact native decisions and string/numeric request IDs", async () => {
  const amendment = {
    acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] },
  };
  const requests = [
    {
      id: "command-request",
      method: "item/commandExecution/requestApproval",
      params: {
        command: "npm test",
        availableDecisions: ["accept", amendment, "decline"],
      },
    },
    {
      id: 91,
      method: "item/fileChange/requestApproval",
      params: { reason: "Write generated files" },
    },
    {
      id: 92,
      method: "item/commandExecution/requestApproval",
      params: { command: "unknown choice" },
    },
  ];
  let count = 0;
  const f = await runFixture(
    { REQUESTS: JSON.stringify(requests) },
    async () => ({
      optionId: ["decision:1", "decision:2", "not-a-decision"][count++],
    }),
  );
  try {
    assert.equal((await f.session.completion).exitCode, 0);
    assert.deepEqual(evidence(f.events).replies, [
      { id: "command-request", result: { decision: amendment } },
      { id: 91, result: { decision: "decline" } },
      { id: 92, result: { decision: "cancel" } },
    ]);
    assert.equal(f.prompts[0].kind, "approval");
    assert.equal(f.prompts[0].options?.[1].kind, "other");
  } finally {
    await f.cleanup();
  }
});

test("Codex structured questions retain native answers, free text, multiple values and secret masking", async () => {
  const requests = [
    {
      id: "question-native",
      method: "item/tool/requestUserInput",
      params: {
        isBlocking: true,
        itemId: "question",
        questions: [
          {
            id: "color",
            header: "Color",
            question: "Choose color",
            options: [{ label: "Green", description: "Default" }],
          },
          {
            id: "custom",
            header: "Custom",
            question: "Describe it",
            isOther: true,
            multiple: true,
            options: [
              { label: "Small", description: "Compact" },
              { label: "Large", description: "Roomy" },
            ],
          },
          {
            id: "secret",
            header: "Secret",
            question: "Passphrase",
            isSecret: true,
          },
        ],
      },
    },
  ];
  const f = await runFixture(
    { REQUESTS: JSON.stringify(requests) },
    async () => ({
      answers: {
        color: "answer:0",
        custom: ["answer:1", "Custom wording"],
        secret: "fixture-not-a-real-secret",
      },
    }),
  );
  try {
    assert.equal((await f.session.completion).exitCode, 0);
    assert.deepEqual(evidence(f.events).replies[0], {
      id: "question-native",
      result: {
        answers: {
          color: { answers: ["Green"] },
          custom: { answers: ["Large", "Custom wording"] },
          secret: { answers: ["fixture-not-a-real-secret"] },
        },
      },
    });
    assert.equal(f.prompts[0].questions?.[2].secret, true);
    assert.equal(f.prompts[0].questions?.[1].multiple, true);
    assert.equal(f.prompts[0].questions?.[0].allowText, false);
  } finally {
    await f.cleanup();
  }
});

test("Codex MCP forms and extra permission scopes require explicit human input; unknown methods fail closed", async () => {
  const requests = [
    {
      id: "form",
      method: "mcpServer/elicitation/request",
      params: {
        mode: "form",
        message: "Choose",
        requestedSchema: {
          type: "object",
          required: ["count"],
          properties: {
            count: { type: "integer" },
            active: { type: "boolean" },
          },
        },
      },
    },
    {
      id: "permission",
      method: "item/permissions/requestApproval",
      params: { permissions: { network: { enabled: true } } },
    },
    {
      id: "unsupported",
      method: "item/tool/call",
      params: { tool: "arbitrary" },
    },
  ];
  const f = await runFixture(
    { REQUESTS: JSON.stringify(requests) },
    async (prompt) =>
      prompt.kind === "question"
        ? { answers: { count: "3", active: "field:0" } }
        : { optionId: "deny" },
  );
  try {
    assert.equal((await f.session.completion).exitCode, 0);
    const replies = evidence(f.events).replies;
    assert.deepEqual(replies[0].result, {
      action: "accept",
      content: { count: 3, active: true },
    });
    assert.deepEqual(replies[1].result, { permissions: {}, scope: "turn" });
    assert.equal(replies[2].error.code, -32601);
    assert.equal(f.prompts.length, 2);
  } finally {
    await f.cleanup();
  }
});

test("Codex stop aborts pending human input and ends the native session without approving", async () => {
  let ready!: () => void,
    aborted = false;
  const waiting = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const f = await runFixture(
    {
      WAIT: "yes",
      REQUESTS: JSON.stringify([
        { id: 9, method: "item/fileChange/requestApproval", params: {} },
      ]),
    },
    async (_prompt, signal) => {
      ready();
      return await new Promise((resolve) =>
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve({ cancelled: true });
          },
          { once: true },
        ),
      );
    },
  );
  try {
    await waiting;
    f.session.stop();
    assert.equal((await f.session.completion).exitCode, 130);
    assert.equal(aborted, true);
  } finally {
    await f.cleanup();
  }
});

test("Codex native failures and malformed transport never count as successful coding turns", async () => {
  for (const env of [{ FAIL: "yes" }, { MALFORMED: "yes" }] as Record<
    string,
    string
  >[]) {
    const f = await runFixture(env);
    try {
      const result = await f.session.completion;
      assert.equal(result.exitCode, 1);
      assert.match(result.error || "", /Native failure|invalid protocol/);
    } finally {
      await f.cleanup();
    }
  }
});
