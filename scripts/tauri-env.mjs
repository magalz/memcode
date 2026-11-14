import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export function nativeEnv(extra = {}) {
  const env = { ...process.env, ...extra, MEMCODE_NODE_PATH: process.execPath };
  delete env.ELECTRON_RUN_AS_NODE;
  const key =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const cargo = join(
    homedir(),
    "scoop",
    "apps",
    "rustup-gnu",
    "current",
    ".cargo",
    "bin",
  );
  env[key] = [
    ...(existsSync(cargo) ? [cargo] : []),
    ...new Set(
      (env[key] ?? "")
        .split(delimiter)
        .map((part) => part.replace(/^"|"$/g, ""))
        .filter(Boolean),
    ),
  ].join(delimiter);
  return env;
}
export function nativeBuildEnv(extra = {}) {
  const env = nativeEnv(extra);
  if (process.platform === "win32" && !env.RUSTUP_TOOLCHAIN) {
    let toolchain = "stable-x86_64-pc-windows-msvc";
    try {
      const installed = execFileSync("rustup", ["toolchain", "list"], {
        env,
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      })
        .split(/\r?\n/)
        .map((line) => line.split(" ")[0])
        .filter((name) => name.endsWith("-pc-windows-msvc"))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      toolchain = installed[0] ?? toolchain;
    } catch {}
    env.RUSTUP_TOOLCHAIN = toolchain;
    env.MEMCODE_TOOLCHAIN_OVERRIDE = "1";
  }
  return env;
}
export function nativeBinary() {
  const executable = process.platform === "win32" ? "memcode.exe" : "memcode";
  const profile =
    process.env.MEMCODE_NATIVE_PROFILE ??
    (existsSync(resolve("src-tauri/target/release", executable))
      ? "release"
      : "debug");
  return resolve("src-tauri/target", profile, executable);
}
