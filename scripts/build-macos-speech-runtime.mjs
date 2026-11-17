// Build a small, relocatable CPU whisper-server. This runs on the release
// runner, never on a user's computer. The output is a review candidate only.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { zipSync } from "fflate";

assert.equal(process.platform, "darwin", "Use the native Mac build runner.");
assert.equal(process.arch, "arm64", "The supported Mac installer is Apple Silicon.");
const upstream = "306c88f4d1286aec1bf96e544632897886af5501";
const version = "v1.9.2";
const minimumMacOS = "13.5";
const output = resolve(process.argv[2] ?? "release/macos-speech-runtime");
const temporary = await mkdtemp(join(tmpdir(), "memcode-speech-build-"));
const source = join(temporary, "whisper.cpp"), build = join(temporary, "build");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const run = (file, args, options = {}) => execFileSync(file, args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600000,
  windowsHide: true, ...options,
});
await mkdir(source); await mkdir(output, { recursive: true });
run("git", ["-c", "core.hooksPath=/dev/null", "init", source]);
run("git", ["-c", "core.hooksPath=/dev/null", "-C", source, "fetch", "--depth=1", "https://github.com/ggml-org/whisper.cpp.git", upstream]);
run("git", ["-c", "core.hooksPath=/dev/null", "-C", source, "checkout", "--detach", "FETCH_HEAD"]);
assert.equal(run("git", ["-C", source, "rev-parse", "HEAD"]).trim(), upstream);
const definitions = {
  CMAKE_BUILD_TYPE: "Release", CMAKE_OSX_ARCHITECTURES: "arm64",
  CMAKE_OSX_DEPLOYMENT_TARGET: minimumMacOS, BUILD_SHARED_LIBS: "OFF",
  GGML_METAL: "OFF", GGML_ACCELERATE: "ON", GGML_BLAS: "OFF",
  GGML_OPENMP: "OFF", GGML_NATIVE: "OFF", GGML_CCACHE: "OFF",
  WHISPER_COREML: "OFF", WHISPER_CURL: "OFF", WHISPER_SDL2: "OFF",
  WHISPER_BUILD_TESTS: "OFF", WHISPER_BUILD_EXAMPLES: "ON", WHISPER_BUILD_SERVER: "ON",
  CMAKE_C_FLAGS: `-ffile-prefix-map=${temporary}=/memcode-speech-build`,
  CMAKE_CXX_FLAGS: `-ffile-prefix-map=${temporary}=/memcode-speech-build`,
};
run("cmake", ["-S", source, "-B", build, ...Object.entries(definitions).map(([key, value]) => `-D${key}=${value}`)]);
run("cmake", ["--build", build, "--config", "Release", "--target", "whisper-server", "--parallel", "3"]);
const executable = join(build, "bin/whisper-server");
await chmod(executable, 0o755);
assert.equal(run("/usr/bin/lipo", ["-archs", executable]).trim(), "arm64");
const dependencies = run("/usr/bin/otool", ["-L", executable]).trim().split("\n").slice(1).map(line => line.trim().split(" ")[0]);
assert.ok(dependencies.length > 0);
assert.ok(dependencies.every(value => value.startsWith("/System/Library/") || value.startsWith("/usr/lib/")), "The runtime must not require Homebrew or private build libraries.");
const loadCommands = run("/usr/bin/otool", ["-l", executable]);
const nativeMinimum = loadCommands.match(/cmd LC_BUILD_VERSION[\s\S]*?\bminos\s+([\d.]+)/)?.[1];
assert.ok(nativeMinimum && Number(nativeMinimum.split(".")[0]) <= 13 && (Number(nativeMinimum.split(".")[0]) < 13 || Number(nativeMinimum.split(".")[1]) <= 5));
run("/usr/bin/codesign", ["--force", "--sign", "-", executable]);
run("/usr/bin/codesign", ["--verify", "--strict", executable]);
const helpResult = spawnSync(executable, ["--help"], { encoding: "utf8", timeout: 30000 });
assert.equal(helpResult.status, 0);
const help = helpResult.stdout + helpResult.stderr;
assert.ok(help.includes("--model") && help.includes("--host") && help.includes("--port"));

// Preserve original licenses, including the decoder and HTTP/JSON dependencies
// statically linked by the upstream server's common library.
const licenseParts = ["whisper.cpp / ggml\n" + await readFile(join(source, "LICENSE"), "utf8")];
for (const [name, path, marker] of [
  ["miniaudio", "examples/miniaudio.h", "This software is available as a choice of the following licenses."],
  ["stb_vorbis", "examples/stb_vorbis.c", "This software is available under 2 licenses -- choose whichever you prefer."],
]) {
  const text = await readFile(join(source, path), "utf8"), at = text.lastIndexOf(marker);
  assert.ok(at > 0); const license = text.slice(at).replace(/\*\/\s*$/, "").trim();
  assert.ok(license.includes("Permission is hereby granted"));
  licenseParts.push(name + "\nSource: https://github.com/ggml-org/whisper.cpp/blob/" + upstream + "/" + path + "\n\n" + license);
}
for (const [name, url, expected] of [
  ["nlohmann JSON 3.11.2", "https://raw.githubusercontent.com/nlohmann/json/v3.11.2/LICENSE.MIT", "86b998c792894ccb911a1cb7994f7a9652894e7a094c0b5e45be2f553f45cf14"],
  ["cpp-httplib 0.20.0", "https://raw.githubusercontent.com/yhirose/cpp-httplib/v0.20.0/LICENSE", "4b45cbe16d7b71b89ae6127e26e0d90a029198ca5e958ad8e3d0b8bbed364d8b"],
]) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) }); assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(digest(bytes), expected);
  licenseParts.push(name + "\nSource: " + url + "\n\n" + bytes.toString());
}
const jsonHeader = (await readFile(join(source, "examples/json.hpp"), "utf8")).split("\n").slice(0, 7).join("\n");
const httpHeader = (await readFile(join(source, "examples/server/httplib.h"), "utf8")).split("\n").slice(0, 6).join("\n");
licenseParts.push("Original JSON and HTTP attribution headers\n\n" + jsonHeader + "\n\n" + httpHeader);

const modelResponse = await fetch("https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin", { signal: AbortSignal.timeout(240000) });
assert.equal(modelResponse.status, 200);
const model = Buffer.from(await modelResponse.arrayBuffer());
assert.equal(model.length, 77691713); assert.equal(digest(model), "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21");
const modelPath = join(temporary, "ggml-tiny.bin"); await writeFile(modelPath, model);
const audio = await readFile(join(source, "samples/jfk.wav"));
assert.equal(audio.toString("ascii", 0, 4), "RIFF");
const listener = createServer(); await new Promise(done => listener.listen(0, "127.0.0.1", done));
const port = listener.address().port; await new Promise(done => listener.close(done));
const child = spawn(executable, ["--model", modelPath, "--host", "127.0.0.1", "--port", String(port), "--language", "auto", "--threads", "4"], { stdio: "ignore", shell: false });
let transcriptionPassed = false, serverExited = false; const started = Date.now();
try {
  const deadline = Date.now() + 60000; let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw Error("The native CPU speech runtime exited during startup.");
    ready = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }).then(r => r.status < 500).catch(() => false);
    if (ready) break; await new Promise(done => setTimeout(done, 150));
  }
  assert.equal(ready, true);
  const form = new FormData(); form.append("file", new Blob([audio], { type: "audio/wav" }), "jfk.wav"); form.append("response_format", "json"); form.append("language", "auto"); form.append("temperature", "0");
  const response = await fetch(`http://127.0.0.1:${port}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(120000) }); assert.equal(response.status, 200);
  const text = (await response.json()).text.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ");
  transcriptionPassed = text.includes("ask not what your country can do for you") && text.includes("what you can do for your country");
  assert.equal(transcriptionPassed, true, "The real local model must transcribe the known public-domain sample.");
} finally {
  child.kill("SIGTERM");
  serverExited = await new Promise(done => { if (child.exitCode !== null || child.signalCode !== null) return done(true); const timer = setTimeout(() => { child.kill("SIGKILL"); done(false); }, 5000); child.once("exit", () => { clearTimeout(timer); done(true); }); });
}
assert.equal(serverExited, true);
const binary = await readFile(executable);
const provenance = { product: "whisper.cpp", version, source: { repository: "ggml-org/whisper.cpp", commit: upstream }, target: "macos-aarch64", nativeMinimum, cpuOnly: true, metal: false, coreML: false, definitions, dependencies, executableSha256: digest(binary), executableBytes: binary.length, builderSourceCommit: process.env.GITHUB_SHA ?? "local", ciRun: process.env.GITHUB_RUN_ID ?? null, originalNoticesIncluded: true };
const files = { "whisper-server": binary, "LICENSES.txt": Buffer.from(licenseParts.join("\n\n---\n\n") + "\n"), "SOURCE.json": Buffer.from(JSON.stringify(provenance, null, 2) + "\n") };
const archive = Buffer.from(zipSync(files, { level: 9, mtime: new Date("2026-01-01T00:00:00Z") }));
const name = `whisper-cpu-${version}-macos-aarch64-${digest(archive).slice(0, 16)}.zip`;
await writeFile(join(output, name), archive);
const report = { ...provenance, passed: true, realNativeTranscription: transcriptionPassed, modelSha256: digest(model), fixtureSha256: digest(audio), microphoneUsed: false, cloudInference: false, directChildExited: serverExited, transcriptionAndStartupMs: Date.now() - started, archive: { name, bytes: archive.length, sha256: digest(archive) }, files: Object.entries(files).map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: digest(bytes) })) };
await writeFile(join(output, "candidate.json"), JSON.stringify(report, null, 2) + "\n");
await copyFile(join(output, "candidate.json"), join(output, "provenance.json"));
await writeFile(join(output, "SHA256SUMS"), `${digest(archive)}  ${name}\n${digest(await readFile(join(output, "candidate.json")))}  candidate.json\n`);
console.log(JSON.stringify({ passed: true, version, upstream, nativeMinimum, systemDependenciesOnly: true, realNativeTranscription: true, directChildExited: true, archive: report.archive, output }));
