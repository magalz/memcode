// Explicit real-model integration fixture. This never opens a user profile or account.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createRuntime } from "../../runtime/app";
import { LocalStore } from "../../runtime/local";
import { ManagedRetrievalAssistant } from "../../runtime/context/managed-assistant";
import { retrievalModel } from "../../runtime/context/retriever-model";
import { contextAssistantDefaults } from "../../src/context-settings";
import { initialState } from "../../src/seed";
import type { AppState, Harness } from "../../src/shared";
import type { SpeechStatus } from "../../src/speech";
import type { ContextAssistantSetupState } from "../../src/context-settings";

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function fileDigest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function snapshot(state: AppState) {
  return structuredClone({
    settings: state.settings,
    workerConnections: state.workerConnections,
    onboarding: state.onboarding,
    projectOnboarding: state.projectOnboarding,
    onboardingPreferences: state.onboardingPreferences,
    activeProjectId: state.activeProjectId,
    projects: state.projects,
    epics: state.epics,
    tasks: state.tasks,
    storyComments: state.storyComments,
  });
}
async function main() {
  const [resources, profile, phase] = process.argv.slice(2);
  assert.ok(
    resources && isAbsolute(resources) && profile && isAbsolute(profile),
  );
  assert.ok(["cold", "upgraded", "restarted"].includes(phase));
  const cold = phase === "cold",
    started = Date.now(),
    data = join(profile, "data");
  let stage = "environment",
    remoteRequests = 0;
  const report: Record<string, unknown> = {
    phase,
    passed: false,
    realModels: true,
    currentProductRpcUsed: true,
    historicalOldProductCodeExecuted: false,
    accountUsed: false,
    workerStarted: false,
    cloudInference: false,
    fixtureAudioOnly: true,
    microphoneCaptureTested: false,
    allSubprocessNetworkObserved: false,
  };
  const progress = (value: string) => {
    stage = value;
    console.log(
      "[memcode-upgrade-models] " +
        JSON.stringify({ phase, stage, elapsedMs: Date.now() - started }),
    );
  };
  assert.equal(process.env.HOME, join(profile, "home"));
  assert.equal(process.env.USERPROFILE, join(profile, "home"));
  assert.equal(
    resolve(process.execPath),
    resolve(
      resources,
      "desktop-runtime",
      process.platform === "win32" ? "node.exe" : "node",
    ),
  );
  await mkdir(data, { recursive: true, mode: 0o700 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
      remoteRequests++;
      if (!cold)
        return Promise.reject(
          new Error("Offline upgrade acceptance forbids remote requests."),
        );
    }
    return originalFetch(input, init);
  };
  if (cold) {
    const saved = new LocalStore(data),
      state = initialState(),
      at = "2026-11-17T09:00:00.000Z";
    const projectId = "synthetic-upgrade-project",
      epicId = "synthetic-upgrade-epic",
      storyId = "synthetic-upgrade-story";
    state.projects = [
      {
        id: projectId,
        name: "Synthetic model upgrade",
        description: "Disposable acceptance fixture",
        path: null,
        branch: "main",
        analysis: "idle",
        createdAt: at,
      },
    ];
    state.epics = [
      {
        id: epicId,
        projectId,
        identifier: "EP-01",
        title: "Saved upgrade fixture",
        description: "Preserve this epic",
        phase: "now",
        color: "mint",
        order: 0,
        branch: "main",
      },
    ];
    state.tasks = [
      {
        ...state.tasks[0],
        id: storyId,
        projectId,
        epicId,
        identifier: "MC-001",
        title: "Saved model upgrade story",
        description: "A synthetic saved brief",
        example: false,
        stage: "planned",
        run: { state: "idle" },
        messages: [
          { id: "brief", role: "user", text: "Keep my saved brief", at },
        ],
      },
    ];
    state.artifacts = [];
    state.activeProjectId = projectId;
    state.storyComments = [
      {
        id: "comment",
        taskId: storyId,
        text: "Saved review note",
        author: { id: "synthetic", name: "Synthetic QA", source: "local" },
        createdAt: at,
        updatedAt: at,
      },
    ];
    state.settings = {
      ...state.settings,
      memtracePath: join(profile, "not-an-installed-memtrace"),
      maxWorkers: 7,
      defaultHarness: "cursor",
      model: "saved-provider-choice",
      workerPermissionDefaults: {
        codex: "auto",
        claude: "full-access",
        cursor: "review",
      },
    };
    state.workerConnections = Object.fromEntries(
      (["codex", "claude", "cursor"] as Harness[]).map((harness) => [
        harness,
        {
          harness,
          approvedAt: at,
          scopeVersion: 1,
          auth: "authenticated",
          accountLabel: "synthetic@example.invalid",
          runtimePath: join(profile, "synthetic-providers", harness),
          runtimeIdentity: join(profile, "synthetic-providers", harness),
        },
      ]),
    ) as AppState["workerConnections"];
    state.onboarding = {
      version: 1,
      step: "ready",
      projectId,
      epicId,
      storyId,
      dismissed: true,
      completedAt: at,
    };
    state.projectOnboarding = {
      [projectId]: structuredClone(state.onboarding),
    };
    state.onboardingPreferences = { showForNewProjects: false };
    saved.state = state;
    await saved.save();
  }
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  let retrieval: ManagedRetrievalAssistant | undefined;
  const nativeMethods = new Set<string>();
  try {
    progress("runtime-start");
    runtime = await createRuntime(
      data,
      resources,
      {
        call: async <T>(method: string) => {
          nativeMethods.add(method);
          if (method === "beta_store_read")
            return { configured: false, credentials: null } as T;
          // Preview teardown has no window in this headless fixture.
          if (method === "preview_hide") return undefined as T;
          throw Error(
            "Unexpected native action in isolated acceptance: " + method,
          );
        },
      },
      () => {},
      { discoverHarnesses: async () => [] },
    );
    const rpc = runtime.request.bind(runtime);
    const beforeSetup = structuredClone(runtime.store.state.settings);
    if (!cold) {
      assert.deepEqual(
        snapshot(runtime.store.state),
        JSON.parse(
          await readFile(join(profile, "saved-snapshot.json"), "utf8"),
        ),
      );
      report.settingsAndWorkspacePreserved = true;
    }
    progress(cold ? "speech-install" : "speech-prepare");
    const speech = (await rpc(
      cold ? "speech:install" : "speech:prepare",
    )) as SpeechStatus;
    assert.equal(speech.state, "ready");
    assert.equal(speech.settings.mode, "managed");
    for (const path of [
      speech.settings.executable,
      speech.settings.modelPath,
    ]) {
      const rel = relative(profile, path);
      assert.ok(
        rel && !rel.startsWith("..") && !isAbsolute(rel),
        "All installed speech files must stay in the private profile.",
      );
    }
    progress(cold ? "retrieval-install" : "retrieval-status");
    let installed: ContextAssistantSetupState;
    if (cold) {
      await rpc("retrieval:configure", {
        ...contextAssistantDefaults,
        enabled: true,
      });
      let setupSettled = false;
      const setup = rpc("retrieval:setup").finally(() => {
        setupSettled = true;
      });
      await rpc("retrieval:configure", {
        ...contextAssistantDefaults,
        enabled: false,
      });
      assert.equal(
        setupSettled,
        false,
        "Disable must be tested while setup is still in flight.",
      );
      installed = (await setup) as ContextAssistantSetupState;
      assert.equal(
        runtime.store.state.settings.contextAssistant?.enabled,
        false,
        "Setup completion must not override a newer explicit disable.",
      );
      const disk = new LocalStore(data);
      await disk.load();
      assert.equal(disk.state.settings.contextAssistant?.enabled, false);
      report.latestDisablePreservedDuringModelSetup = true;
    } else
      installed = (await rpc("retrieval:status")) as ContextAssistantSetupState;
    assert.equal(installed.status, "ready");
    if (cold) {
      await rpc("retrieval:configure", {
        ...contextAssistantDefaults,
        enabled: true,
      });
      // Reproduce a dialog opened BEFORE either setup completed. The global save
      // must keep each independently persisted setup, without another setup click.
      await rpc("settings:save", {
        ...beforeSetup,
        model: "updated-saved-provider-choice",
      });
      assert.deepEqual(runtime.store.state.settings.speech, speech.settings);
      assert.deepEqual(runtime.store.state.settings.contextAssistant, {
        ...contextAssistantDefaults,
        enabled: true,
      });
      const audio = await fetch(
        "https://raw.githubusercontent.com/ggml-org/whisper.cpp/306c88f4d1286aec1bf96e544632897886af5501/samples/jfk.wav",
        { redirect: "error", signal: AbortSignal.timeout(30_000) },
      );
      assert.equal(audio.status, 200);
      const bytes = Buffer.from(await audio.arrayBuffer());
      assert.equal(bytes.length, 352078);
      assert.equal(
        digest(bytes),
        "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e",
      );
      await writeFile(join(profile, "fixture.wav"), bytes, { mode: 0o600 });
      report.staleSettingsSnapshotPreservedCompletedSetup = true;
    }
    assert.equal(runtime.store.state.settings.contextAssistant?.enabled, true);
    assert.equal(
      runtime.store.state.settings.contextAssistant?.provider,
      "onnx",
    );
    progress("speech-transcription");
    const inferenceRequests = remoteRequests;
    const transcript = (await rpc(
      "speech:transcribe",
      (await readFile(join(profile, "fixture.wav"))).toString("base64"),
    )) as string;
    const normalized = transcript
      .toLowerCase()
      .replace(/[^a-z ]/g, " ")
      .replace(/\s+/g, " ");
    assert.ok(normalized.includes("ask not what your country can do for you"));
    assert.ok(normalized.includes("what you can do for your country"));
    report.realSpeechTranscriptionPassed = true;
    // Same real cache, current runtime location; no seam replaces inference.
    retrieval = new ManagedRetrievalAssistant(data, {
      runtimeDirectory: join(resources, "retriever-runtime"),
      fetch,
    });
    assert.equal((await retrieval.status()).status, "ready");
    const assistant = await retrieval.assistant();
    try {
      progress("retrieval-plan");
      const plan = await assistant.plan("find validateSession token expiry");
      assert.ok(
        typeof plan.query === "string" &&
          plan.query.trim() &&
          plan.query.length <= 300,
      );
      const usage = plan.usage as {
        inputTokens?: number;
        outputRetokenized?: number;
      };
      assert.ok(
        typeof usage?.inputTokens === "number" && usage.inputTokens > 0,
      );
      assert.ok(
        typeof usage?.outputRetokenized === "number" &&
          usage.outputRetokenized > 0,
      );
      report.localTokenizerInputTokens = usage.inputTokens;
      report.outputRetokenizedTokens = usage.outputRetokenized;
      progress("retrieval-rank");
      const ranked = await assistant.rank(
        "validate authentication session token expiry",
        [
          { id: "a", symbol: "validateSession", file: "src/auth/session.ts" },
          { id: "b", symbol: "renderFooter", file: "src/ui/footer.ts" },
        ],
      );
      assert.ok(ranked.ids.length > 0 && ranked.ids.length <= 2);
      assert.equal(ranked.ids[0], "a");
      assert.equal(new Set(ranked.ids).size, ranked.ids.length);
      assert.ok(ranked.ids.every((id) => ["a", "b"].includes(id)));
      report.realRetrievalPlanAndRankPassed = true;
    } finally {
      await assistant.close?.();
    }
    assert.equal(remoteRequests, inferenceRequests);
    progress("cache-identity");
    const cacheFiles = [
      speech.settings.executable,
      speech.settings.modelPath,
      join(data, "local-retriever", retrievalModel.revision, "ready.json"),
      ...retrievalModel.assets.map((asset) =>
        join(retrieval!.modelDirectory, asset.name),
      ),
    ];
    const cacheIdentity = await Promise.all(
      cacheFiles.map(async (path) => ({
        file: relative(profile, path),
        sha256: await fileDigest(path),
      })),
    );
    if (cold) {
      await writeFile(
        join(profile, "saved-cache-identity.json"),
        JSON.stringify(cacheIdentity),
        { mode: 0o600 },
      );
      await writeFile(
        join(profile, "saved-snapshot.json"),
        JSON.stringify(snapshot(runtime.store.state)),
        { mode: 0o600 },
      );
    } else {
      assert.deepEqual(
        cacheIdentity,
        JSON.parse(
          await readFile(join(profile, "saved-cache-identity.json"), "utf8"),
        ),
      );
      assert.equal(remoteRequests, 0);
      report.identicalModelBytesAndReceipts = true;
      report.offlineCachedUpgradeVerified = true;
    }
    report.cacheFilesVerified = cacheIdentity.length;
    report.savedWorkerApprovalsChecked = Object.keys(
      runtime.store.state.workerConnections ?? {},
    ).length;
    assert.equal(report.savedWorkerApprovalsChecked, 3);
    assert.ok(
      runtime.store.state.tasks.every((task) => task.run.state === "idle"),
    );
    report.passed = true;
  } catch (error) {
    report.failedStage = stage;
    report.failureType =
      error instanceof assert.AssertionError
        ? "assertion"
        : error instanceof SyntaxError
          ? "invalid-model-json"
          : "runtime";
    process.exitCode = 1;
  } finally {
    progress("cleanup");
    try {
      await retrieval?.close();
      await runtime?.close();
      report.runtimeCloseCompleted = true;
    } catch {
      report.runtimeCloseCompleted = false;
      report.passed = false;
      process.exitCode = 1;
    }
    report.nativeMethods = [...nativeMethods].sort();
    report.remoteRequests = remoteRequests;
    report.elapsedMs = Date.now() - started;
    await writeFile(
      join(profile, `${phase}.json`),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
  }
}
void main().catch(async () => {
  process.exitCode = 1;
  const [, profile, phase] = process.argv.slice(2);
  if (
    profile &&
    isAbsolute(profile) &&
    ["cold", "upgraded", "restarted"].includes(phase)
  )
    await writeFile(
      join(profile, `${phase}.json`),
      JSON.stringify({
        phase,
        passed: false,
        failedStage: "fixture-initialization",
        failureType: "runtime",
      }) + "\n",
      { mode: 0o600 },
    ).catch(() => {});
});
