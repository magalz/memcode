import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { childEnv, findCommand } from "./commands";
import type { NativeHost } from "./host";
import type { MemtraceAccount } from "../src/connections";

const execute = promisify(execFile);
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
const safeId = (value: unknown) =>
  typeof value === "string" && /^[\w.@:/-]{1,200}$/.test(value)
    ? value
    : undefined;
export function parseMemtraceStatus(data: unknown): MemtraceAccount {
  const status = data as {
    auth_session?: { state?: unknown; degraded?: unknown };
    memdb?: {
      mode?: unknown;
      owner_reachable?: unknown;
      seat_principal?: unknown;
      user_org_id?: unknown;
    };
  };
  const valid =
    status?.auth_session?.state === "Valid" &&
    status.auth_session.degraded === false;
  const hasSessionContext =
    status.memdb?.owner_reachable === true ||
    (status.memdb?.mode === "external" &&
      !!safeId(status.memdb?.seat_principal));
  const active = valid && hasSessionContext;
  const principal = active ? safeId(status.memdb?.seat_principal) : undefined;
  return {
    status: active
      ? "connected"
      : status?.auth_session?.degraded === true
        ? "needs-sign-in"
        : "unknown",
    label: active
      ? "Memtrace connected"
      : valid
        ? "Memtrace installed"
        : "Memtrace sign-in",
    detail: principal
      ? "Using the existing Memtrace seat session. No separate MemCode account is created."
      : active
        ? "Using the existing Memtrace session. This CLI does not expose an account profile; a valid license/session is not a verified person identity."
        : valid
          ? "Memtrace is installed, but this standalone status has no active owner or account identity. Open a project to connect the engine, or sign in through Memtrace."
          : "Sign in through Memtrace to use its existing session. MemCode never creates a separate account.",
    principal: principal
      ? { id: principal, name: "Memtrace member", source: "memtrace" }
      : undefined,
    organizationId: active ? safeId(status.memdb?.user_org_id) : undefined,
    checkedAt: new Date().toISOString(),
    loginPending: false,
  };
}
export function memtraceClaimUrl(value: string): string | undefined {
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      !["memtrace.io", "www.memtrace.io"].includes(u.hostname) ||
      u.pathname !== "/claim" ||
      u.username ||
      u.password ||
      u.port ||
      u.hash ||
      [...u.searchParams.keys()].some((k) => k !== "code") ||
      !/^[-\w]{6,250}$/.test(u.searchParams.get("code") ?? "")
    )
      return;
    return u.href;
  } catch {
    return;
  }
}
export class MemtraceAccountManager {
  current: MemtraceAccount = {
    status: "unknown",
    label: "Memtrace account",
    detail: "Use your existing Memtrace session.",
    loginPending: false,
  };
  private login?: ChildProcess;
  private timer?: ReturnType<typeof setTimeout>;
  private refreshing?: Promise<MemtraceAccount>;
  private closing = false;
  private confirmedByLoginAt?: string;
  private statusAbort?: AbortController;
  constructor(
    private readonly configuredPath: () => string,
    private readonly host: NativeHost,
  ) {}
  refresh(): Promise<MemtraceAccount> {
    if (this.closing) return Promise.resolve(this.current);
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.read().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }
  private async read() {
    const command = await findCommand("memtrace", this.configuredPath());
    if (this.closing) return this.current;
    if (!command)
      return (this.current = {
        status: "unavailable",
        label: "Memtrace not found",
        detail: "Install Memtrace or choose its executable in Settings.",
        loginPending: !!this.login,
      });
    try {
      this.statusAbort = new AbortController();
      const { stdout } = await execute(
        command.command,
        [...command.prefix, "status", "--json"],
        {
          env: { ...childEnv(), ...command.env },
          windowsHide: true,
          timeout: 15000,
          maxBuffer: 1_000_000,
          encoding: "utf8",
          signal: this.statusAbort.signal,
        },
      );
      const start = stdout.indexOf("{");
      const raw = JSON.parse(stdout.slice(start));
      const result = parseMemtraceStatus(raw);
      if (
        this.confirmedByLoginAt &&
        result.status === "unknown" &&
        raw.auth_session?.state === "Valid" &&
        raw.auth_session?.degraded === false
      ) {
        result.status = "connected";
        result.label = "Memtrace connected";
        result.detail =
          "The official Memtrace login command confirmed this session. This CLI does not expose a person profile; no separate MemCode account is created.";
      }
      this.current = {
        ...result,
        loginPending: !!this.login,
        claimUrl: this.current.claimUrl,
      };
    } catch {
      this.current = {
        status: "unknown",
        label: "Memtrace status unavailable",
        detail:
          "The installed CLI could not report its session. Check Memtrace in Settings, then refresh.",
        checkedAt: new Date().toISOString(),
        loginPending: !!this.login,
        claimUrl: this.current.claimUrl,
      };
    }
    return this.current;
  }
  async signIn() {
    if (this.closing) throw Error("The MemCode workspace is closing.");
    if (this.login) return this.current;
    const command = await findCommand("memtrace", this.configuredPath());
    if (!command)
      throw Error("Install Memtrace or choose its executable in Settings.");
    const child = spawn(command.command, [...command.prefix, "auth", "login"], {
      env: { ...childEnv(), ...command.env },
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.login = child;
    this.current = { ...this.current, loginPending: true, claimUrl: undefined };
    let output = "",
      opened = false;
    const consume = (chunk: Buffer) => {
      output = (output + plain(chunk.toString())).slice(-8000);
      const url = memtraceClaimUrl(
        output.match(/Claim URL:\s*(https:\/\/[^\s]+)/)?.[1] ?? "",
      );
      if (url && !opened) {
        opened = true;
        this.current = { ...this.current, claimUrl: url };
        void this.host.call("open_memtrace_claim", { url }).catch(() => {
          this.current = {
            ...this.current,
            detail:
              "Open the Memtrace claim link to finish sign-in, then refresh.",
          };
        });
      }
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    const finish = (succeeded = false) => {
      if (this.login !== child) return;
      if (succeeded && /Already signed in|You're in\./.test(output))
        this.confirmedByLoginAt = new Date().toISOString();
      this.login = undefined;
      clearTimeout(this.timer);
      this.current = {
        ...this.current,
        loginPending: false,
        claimUrl: undefined,
      };
      if (!this.closing) void this.refresh();
    };
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    this.timer = setTimeout(
      () => {
        void this.stopLogin(child).finally(() => finish(false));
      },
      10 * 60 * 1000,
    );
    return this.current;
  }
  async close() {
    this.closing = true;
    this.statusAbort?.abort();
    if (this.login) await this.stopLogin(this.login);
    this.login = undefined;
    clearTimeout(this.timer);
  }
  private async stopLogin(child: ChildProcess) {
    if (!child.pid || child.exitCode !== null) return;
    if (process.platform === "win32") {
      await execute(
        join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, timeout: 5000, maxBuffer: 16000 },
      ).catch(() => {
        child.kill();
      });
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill();
      }
    }
  }
}
