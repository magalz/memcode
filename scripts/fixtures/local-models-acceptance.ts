// Executed only by scripts/local-models-acceptance.mjs with the verified bundled Node.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { SpeechManager } from "../../runtime/speech";
import { ManagedRetrievalAssistant } from "../../runtime/context/managed-assistant";
import { initialState } from "../../src/seed";
import type { Settings } from "../../src/shared";
import type { RetrievalAssistant } from "../../runtime/context/local-model";

async function main() {
  const [resources, profile, phase, components] = process.argv.slice(2);
  assert.ok(resources && profile && ["cold", "cached"].includes(phase));
  assert.ok(["all", "speech", "retrieval"].includes(components));
  const started = Date.now();
  let stage = "environment";
  const progress = (value: string) => {
    stage = value;
    console.log(
      "[memcode-local-models] " +
        JSON.stringify({ phase, stage, elapsedMs: Date.now() - started }),
    );
  };
  const data = join(profile, "data");
  const settingsPath = join(profile, "settings.json");
  await mkdir(data, { recursive: true, mode: 0o700 });
  const report: Record<string, unknown> = {
    phase,
    passed: false,
    realModels: true,
    fixtureAudioOnly: true,
    cloudInference: false,
    microphoneCaptureTested: false,
    noGlobalModelToolingRequired: true,
    allSubprocessNetworkObserved: false,
    bundledNodePathVerified:
      resolve(process.execPath) ===
      resolve(
        resources,
        "desktop-runtime",
        process.platform === "win32" ? "node.exe" : "node",
      ),
  };
  const state = initialState();
  if (phase === "cached")
    state.settings = JSON.parse(
      await readFile(settingsPath, "utf8"),
    ) as Settings;
  const nativeFetch = globalThis.fetch;
  let remoteRequests = 0;
  const observedFetch: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(
      url.hostname,
    );
    if (!loopback) {
      remoteRequests++;
      if (phase === "cached")
        return Promise.reject(
          new Error("Cached acceptance forbids remote requests."),
        );
    }
    return nativeFetch(input, init);
  };
  // Speech uses the global fetch; retrieval setup accepts this observer explicitly.
  globalThis.fetch = observedFetch;
  const speech = new SpeechManager(
    () => state.settings,
    data,
    async (settings) => {
      state.settings.speech = settings;
      await writeFile(settingsPath, JSON.stringify(state.settings), {
        mode: 0o600,
      });
    },
  );
  const retrieval = new ManagedRetrievalAssistant(data, {
    runtimeDirectory: join(resources, "retriever-runtime"),
    fetch: observedFetch,
  });
  let assistant: RetrievalAssistant | undefined;
  let speechProgressObserved = false;
  let retrievalProgressObserved = false;
  const poll = setInterval(() => {
    if (stage === "speech-install")
      void speech
        .status()
        .then((status) => {
          if (status.progress !== undefined && status.progress > 0)
            speechProgressObserved = true;
        })
        .catch(() => {});
    if (stage === "retrieval-install")
      void retrieval
        .status()
        .then((status) => {
          if (status.downloadedBytes > 0) retrievalProgressObserved = true;
        })
        .catch(() => {});
  }, 250);
  function insideProfile(path: string) {
    const value = relative(profile, path);
    return (
      value !== ".." &&
      !value.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) &&
      !isAbsolute(value)
    );
  }
  try {
    assert.equal(report.bundledNodePathVerified, true);
    assert.equal(process.env.USERPROFILE, join(profile, "home"));
    assert.equal(process.env.HOME, join(profile, "home"));
    const audioPath = join(profile, "fixture.wav");
    if (components !== "retrieval") {
      progress("speech-install");
      const installStarted = Date.now();
      const installed =
        phase === "cold" ? await speech.install() : await speech.prepare();
      assert.equal(installed.managedInstallAvailable, true);
      assert.equal(installed.mode, "managed");
      assert.equal(installed.state, "ready");
      assert.ok(insideProfile(installed.settings.executable));
      assert.ok(insideProfile(installed.settings.modelPath));
      report.speechInstallMs = Date.now() - installStarted;
      report.speechManagedSetupReady = true;
      report.speechDownloadProgressObserved = speechProgressObserved;
      if (phase === "cold") {
        const response = await observedFetch(
          "https://raw.githubusercontent.com/ggml-org/whisper.cpp/306c88f4d1286aec1bf96e544632897886af5501/samples/jfk.wav",
          { redirect: "error", signal: AbortSignal.timeout(30_000) },
        );
        assert.equal(response.status, 200);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(bytes.length, 352078);
        assert.equal(
          createHash("sha256").update(bytes).digest("hex"),
          "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e",
        );
        await writeFile(audioPath, bytes, { mode: 0o600 });
      }
      progress("speech-transcription");
      const before = remoteRequests;
      const inferenceStarted = Date.now();
      const transcript = await speech.transcribe(
        (await readFile(audioPath)).toString("base64"),
      );
      const normalized = transcript
        .toLowerCase()
        .replace(/[^a-z ]/g, " ")
        .replace(/\s+/g, " ");
      assert.ok(
        normalized.includes("ask not what your country can do for you"),
      );
      assert.ok(normalized.includes("what you can do for your country"));
      assert.equal(remoteRequests, before);
      report.realSpeechTranscriptionPassed = true;
      report.speechInferenceMs = Date.now() - inferenceStarted;
      report.audioFixtureSha256 =
        "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e";
    } else if (phase === "cold") {
      await writeFile(settingsPath, JSON.stringify(state.settings), {
        mode: 0o600,
      });
    }
    if (components !== "speech") {
      progress("retrieval-install");
      const installStarted = Date.now();
      const installed =
        phase === "cold" ? await retrieval.install() : await retrieval.status();
      assert.equal(installed.status, "ready");
      report.retrievalInstallMs = Date.now() - installStarted;
      report.retrievalManagedSetupReady = true;
      report.retrievalDownloadProgressObserved = retrievalProgressObserved;
      assistant = await retrieval.assistant();
      const before = remoteRequests;
      progress("retrieval-plan");
      const planStarted = Date.now();
      const plan = await assistant.plan("find validateSession token expiry");
      assert.ok(
        typeof plan.query === "string" &&
          plan.query.trim().length > 0 &&
          plan.query.length <= 300,
      );
      const usage = plan.usage as {
        inputTokens?: unknown;
        outputRetokenized?: unknown;
      };
      assert.ok(
        typeof usage?.inputTokens === "number" && usage.inputTokens > 0,
      );
      assert.ok(
        typeof usage?.outputRetokenized === "number" &&
          usage.outputRetokenized > 0,
      );
      report.realRetrievalPlanPassed = true;
      report.retrievalPlanMs = Date.now() - planStarted;
      report.localTokenizerInputTokens = usage.inputTokens;
      report.outputRetokenizedTokens = usage.outputRetokenized;
      progress("retrieval-rank");
      const candidates = [
        { id: "a", symbol: "validateSession", file: "src/auth/session.ts" },
        { id: "b", symbol: "renderFooter", file: "src/ui/footer.ts" },
      ];
      const ranked = await assistant.rank(
        "validate authentication session token expiry",
        candidates,
      );
      assert.ok(
        ranked.ids.length > 0 && ranked.ids.length <= candidates.length,
      );
      assert.equal(ranked.ids[0], "a");
      assert.equal(new Set(ranked.ids).size, ranked.ids.length);
      assert.ok(
        ranked.ids.every((id) => candidates.some((item) => item.id === id)),
      );
      assert.equal(remoteRequests, before);
      report.realRetrievalRankingPassed = true;
      report.noInventedCandidateIds = true;
      report.modelName = assistant.model;
    }
    if (phase === "cached") assert.equal(remoteRequests, 0);
    report.remoteRequests = remoteRequests;
    report.passed = true;
  } catch (error) {
    report.failedStage = stage;
    report.failureType =
      error instanceof assert.AssertionError
        ? "assertion"
        : error instanceof SyntaxError
          ? "invalid-model-json"
          : "runtime";
    report.remoteRequests = remoteRequests;
    process.exitCode = 1;
  } finally {
    clearInterval(poll);
    const failedStage = report.failedStage;
    progress("cleanup");
    try {
      await assistant?.close?.();
      await retrieval.close();
      await speech.close();
      report.managerCloseCompleted = true;
    } catch {
      report.managerCloseCompleted = false;
      report.passed = false;
      report.failedStage = failedStage ?? "cleanup";
      process.exitCode = 1;
    }
    report.elapsedMs = Date.now() - started;
    await writeFile(
      join(profile, `${phase}.json`),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
  }
}

void main().catch(async () => {
  // Preserve a bounded diagnostic even if initialization fails before managers exist.
  process.exitCode = 1;
  const [, profile, phase] = process.argv.slice(2);
  if (profile && isAbsolute(profile) && ["cold", "cached"].includes(phase)) {
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
  }
});
