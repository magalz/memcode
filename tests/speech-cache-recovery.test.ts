import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  chmod,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { zipSync } from "fflate";
import { initialState } from "../src/seed";
import { SpeechManager } from "../runtime/speech";
import {
  findManagedSpeechAssets,
  type SpeechCacheManifest,
} from "../runtime/speech-install";

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function cached() {
  const directory = await mkdtemp(join(tmpdir(), "memcode-speech-cache-"));
  const executableName =
    process.platform === "win32"
      ? "bin/whisper-server.exe"
      : "bin/whisper-server";
  const files = {
    [executableName]: Buffer.from("synthetic executable; never launched"),
    "bin/ggml-library": Buffer.from("synthetic runtime member"),
    LICENSE: Buffer.from("synthetic fixture license"),
  };
  const zip = zipSync(files),
    model = Buffer.from("synthetic speech model; no inference");
  const manifest: SpeechCacheManifest = {
    version: "fixture-v1",
    platform: process.platform,
    arch: process.arch,
    runtime: {
      url: "https://example.invalid/never-fetched.zip",
      bytes: zip.length,
      sha256: sha(zip),
      executableSha256: sha(files[executableName]),
    },
    modelBytes: model.length,
    modelSha256: sha(model),
  };
  const root = join(directory, "speech"),
    runtime = join(
      root,
      manifest.version,
      `${manifest.platform}-${manifest.arch}-${manifest.runtime.sha256.slice(0, 12)}`,
    );
  const archive = join(
    root,
    `whisper-cpu-${manifest.version}-${manifest.platform}-${manifest.arch}-${manifest.runtime.sha256.slice(0, 12)}.zip`,
  );
  const modelPath = join(root, "ggml-tiny.bin"),
    executable = join(runtime, executableName);
  await mkdir(runtime, { recursive: true });
  await writeFile(archive, zip);
  await writeFile(modelPath, model);
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(join(runtime, name, ".."), { recursive: true });
    await writeFile(join(runtime, name), bytes);
  }
  await chmod(executable, 0o755);
  return {
    directory,
    root,
    runtime,
    archive,
    modelPath,
    executable,
    manifest,
    cleanup: async () => {
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("missing speech settings recover verified cache once without downloads, cache rewrites or inference", async (t) => {
  const f = await cached(),
    state = initialState();
  let reads = 0,
    saves = 0,
    launches = 0,
    network = 0;
  t.mock.method(globalThis, "fetch", async () => {
    network++;
    throw Error("No network during status");
  });
  const recovery = async (directory: string) => {
    reads++;
    return findManagedSpeechAssets(directory, f.manifest);
  };
  const manager = new SpeechManager(
    () => state.settings,
    f.directory,
    async (settings) => {
      saves++;
      state.settings.speech = settings;
      await writeFile(
        join(f.directory, "saved-settings.json"),
        JSON.stringify(state.settings),
      );
    },
    (() => {
      launches++;
      throw Error("Status must not launch a process");
    }) as typeof spawn,
    recovery,
  );
  const paths = [
    f.archive,
    f.modelPath,
    f.executable,
    join(f.runtime, "bin/ggml-library"),
  ];
  const before = await Promise.all(
    paths.map(async (path) => (await stat(path)).mtimeMs),
  );
  try {
    const results = await Promise.all([
      manager.status(),
      manager.status(),
      manager.status(),
    ]);
    assert.ok(
      results.every(
        (result) => result.state === "available" && result.mode === "managed",
      ),
    );
    assert.equal(reads, 1);
    assert.equal(saves, 1);
    assert.equal(network, 0);
    assert.equal(launches, 0);
    assert.equal(state.settings.speech?.modelPath, f.modelPath);
    assert.equal(state.settings.speech?.executable, f.executable);
    const after = await Promise.all(
      paths.map(async (path) => (await stat(path)).mtimeMs),
    );
    assert.deepEqual(
      after,
      before,
      "Recovery does not rewrite or re-extract cached files.",
    );
    const restarted = JSON.parse(
      await readFile(join(f.directory, "saved-settings.json"), "utf8"),
    );
    const next = new SpeechManager(
      () => restarted,
      f.directory,
      async () => {
        saves++;
      },
      (() => {
        launches++;
        throw Error("No process");
      }) as typeof spawn,
      async () => {
        throw Error("A configured restart needs no recovery scan");
      },
    );
    try {
      assert.equal((await next.status()).state, "available");
    } finally {
      await next.close();
    }
    assert.equal(saves, 1);
    assert.equal(launches, 0);
  } finally {
    await manager.close();
    await f.cleanup();
  }
});

test("missing or modified managed speech files are never adopted", async () => {
  for (const damaged of ["model", "archive", "member", "missing"]) {
    const f = await cached(),
      state = initialState();
    let saves = 0;
    if (damaged === "missing") await rm(f.archive);
    else {
      const path =
        damaged === "model"
          ? f.modelPath
          : damaged === "archive"
            ? f.archive
            : f.executable;
      const bytes = await readFile(path);
      bytes[0] ^= 1;
      await writeFile(path, bytes);
    }
    const manager = new SpeechManager(
      () => state.settings,
      f.directory,
      async (settings) => {
        saves++;
        state.settings.speech = settings;
      },
      (() => {
        throw Error("No inference");
      }) as typeof spawn,
      (directory) => findManagedSpeechAssets(directory, f.manifest),
    );
    try {
      assert.equal((await manager.status()).state, "unconfigured", damaged);
      assert.equal(saves, 0);
      assert.equal(state.settings.speech, undefined);
    } finally {
      await manager.close();
      await f.cleanup();
    }
  }
});

test("explicit advanced speech configuration wins over managed-cache recovery", async () => {
  const f = await cached();
  try {
    for (const kind of ["endpoint", "custom-model", "legacy-endpoint"]) {
      const state = initialState();
      if (kind === "legacy-endpoint")
        state.settings.speechEndpoint = "http://127.0.0.1:9191/inference";
      else
        state.settings.speech = {
          mode: kind === "endpoint" ? "endpoint" : "managed",
          executable: "/custom/speech-server",
          modelPath: "/custom/model.bin",
          language: "da",
        };
      const original = structuredClone(state.settings);
      let saves = 0,
        reads = 0;
      const manager = new SpeechManager(
        () => state.settings,
        f.directory,
        async () => {
          saves++;
        },
        spawn,
        async (directory) => {
          reads++;
          return findManagedSpeechAssets(directory, f.manifest);
        },
      );
      try {
        await manager.status();
        assert.deepEqual(state.settings, original, kind);
        assert.equal(saves, 0);
        assert.equal(reads, 0);
      } finally {
        await manager.close();
      }
    }
  } finally {
    await f.cleanup();
  }
});

test("an advanced choice made during cache validation is not overwritten", async () => {
  const f = await cached(),
    state = initialState();
  let resolveRecovery!: (
    value: Awaited<ReturnType<typeof findManagedSpeechAssets>>,
  ) => void;
  let saves = 0;
  const manager = new SpeechManager(
    () => state.settings,
    f.directory,
    async () => {
      saves++;
    },
    spawn,
    () =>
      new Promise((resolve) => {
        resolveRecovery = resolve;
      }),
  );
  try {
    const pending = manager.status();
    state.settings.speech = {
      mode: "endpoint",
      executable: "",
      modelPath: "",
      language: "en",
    };
    state.settings.speechEndpoint = "http://127.0.0.1:9292/inference";
    resolveRecovery(await findManagedSpeechAssets(f.directory, f.manifest));
    assert.equal((await pending).mode, "endpoint");
    assert.equal(saves, 0);
    assert.equal(
      state.settings.speechEndpoint,
      "http://127.0.0.1:9292/inference",
    );
  } finally {
    await manager.close();
    await f.cleanup();
  }
});
