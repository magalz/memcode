import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { childEnv, findCommand } from "./commands";
import { MemtraceAccountManager } from "./account";
import type { NativeHost } from "./host";
import {
  harnessNames,
  type AppState,
  type Harness,
  type HarnessRuntime,
} from "../src/shared";
import type { WorkerConnectionStatus } from "../src/connections";
const execute = promisify(execFile);
const clean = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
const samePath = (a: string, b: string) =>
  process.platform === "win32"
    ? a.replaceAll("\\", "/").toLowerCase() ===
      b.replaceAll("\\", "/").toLowerCase()
    : a === b;
export const loginCommands = {
  codex: "codex login",
  claude: "claude auth login",
  cursor: "agent login",
};
function accountLabel(value: unknown) {
  return typeof value === "string" &&
    /^[^\s@<>]{1,80}@[^\s@<>]{1,80}$/.test(value)
    ? value
    : undefined;
}
export function parseWorkerAuth(
  harness: Harness,
  stdout: string,
  stderr = "",
): Pick<WorkerConnectionStatus, "auth" | "accountLabel"> {
  if (harness === "codex")
    return /Logged in using (ChatGPT|an API key|API key)/i.test(
      clean(stdout + "\n" + stderr),
    )
      ? {
          auth: "authenticated",
          accountLabel: /ChatGPT/i.test(stdout + stderr)
            ? "ChatGPT account"
            : "Configured API key",
        }
      : {
          auth: /not logged in/i.test(stdout + stderr)
            ? "not-authenticated"
            : "unknown",
        };
  try {
    const data = JSON.parse(stdout);
    const authenticated =
      harness === "claude"
        ? data.loggedIn === true
        : data.isAuthenticated === true;
    return {
      auth: authenticated ? "authenticated" : "not-authenticated",
      accountLabel: authenticated
        ? accountLabel(harness === "claude" ? data.email : data.userInfo?.email)
        : undefined,
    };
  } catch {
    return { auth: "unknown" };
  }
}
export function assertWorkerConnected(
  state: AppState,
  harness: Harness,
  path?: string,
) {
  const receipt = state.workerConnections?.[harness];
  if (
    !receipt ||
    receipt.scopeVersion !== 1 ||
    receipt.harness !== harness ||
    typeof receipt.runtimePath !== "string" ||
    !receipt.runtimePath ||
    !["authenticated", "local"].includes(receipt.auth) ||
    !receipt.approvedAt ||
    (path && !samePath(receipt.runtimePath, path))
  )
    throw Error(
      `Connect ${harnessNames[harness]} in Workers before starting a worker.`,
    );
}
export function connectedRuntimes(state: AppState, runtimes: HarnessRuntime[]) {
  return runtimes.filter((runtime) => {
    try {
      if (!runtime.available || !runtime.path) return false;
      assertWorkerConnected(state, runtime.id, runtime.path);
      return true;
    } catch {
      return false;
    }
  });
}
type Register = (
  name: string,
  schema: z.ZodType,
  handler: (input: any) => unknown,
) => void;
export function registerConnections(
  register: Register,
  state: () => AppState,
  changed: () => Promise<void>,
  configuredPath: () => string,
  host: NativeHost,
  commandFor: typeof findCommand = findCommand,
) {
  const account = new MemtraceAccountManager(configuredPath, host),
    id = z.enum(["codex", "claude", "cursor"]);
  // Reuse the existing Memtrace session for host-owned author attribution.
  // This is a read-only status check, not a worker connection or login action.
  void account.refresh().catch(() => {});
  const status = async (harness: Harness): Promise<WorkerConnectionStatus> => {
    const command = await commandFor(harness),
      receipt = state().workerConnections?.[harness];
    if (!command)
      return {
        harness,
        installed: false,
        connected: false,
        runtimePath: null,
        auth: "unknown",
        note: "Install the standalone CLI, then connect it here.",
        loginCommand: loginCommands[harness],
      };
    let auth: Pick<WorkerConnectionStatus, "auth" | "accountLabel"> = {
      auth: "unknown",
    };
    if (harness === "codex" && state().settings.localModel)
      auth = { auth: "local", accountLabel: "Configured local model" };
    else {
      const args =
        harness === "codex"
          ? ["login", "status"]
          : harness === "claude"
            ? ["auth", "status"]
            : ["status", "--format", "json"];
      try {
        const { stdout, stderr } = await execute(
          command.command,
          [...command.prefix, ...args],
          {
            env: { ...childEnv(), ...command.env },
            windowsHide: true,
            timeout: 12000,
            maxBuffer: 128000,
            encoding: "utf8",
          },
        );
        auth = parseWorkerAuth(harness, stdout, stderr);
      } catch {
        /* No raw CLI output or credentials reach the renderer. */
      }
    }
    const approved =
        !!receipt &&
        receipt.scopeVersion === 1 &&
        samePath(receipt.runtimePath, command.command),
      connected =
        approved && (auth.auth === "authenticated" || auth.auth === "local");
    return {
      harness,
      installed: true,
      connected,
      runtimePath: command.command,
      ...auth,
      approvedAt: approved ? receipt.approvedAt : undefined,
      note: connected
        ? "Approved for projects you select. No worker starts until you send work."
        : receipt && !approved
          ? "The installed runtime changed. Review and approve its connection again."
          : auth.auth === "local"
            ? "A local model is configured. Review and approve the connection."
            : auth.auth === "authenticated"
              ? "Installed and signed in. Review and approve the connection."
              : `Sign in with ${loginCommands[harness]}, then check again.`,
      loginCommand: loginCommands[harness],
    };
  };
  register("connection:status", z.undefined(), () =>
    Promise.all((["codex", "claude", "cursor"] as Harness[]).map(status)),
  );
  register(
    "connection:approve",
    z.object({ harness: id, approved: z.literal(true) }).strict(),
    async (input) => {
      const result = await status(input.harness);
      if (!result.installed || !result.runtimePath)
        throw Error("Install the worker CLI before connecting it.");
      if (result.auth !== "authenticated" && result.auth !== "local")
        throw Error(
          `Sign in using ${result.loginCommand}, then connect again.`,
        );
      (state().workerConnections ??= {})[input.harness as Harness] = {
        harness: input.harness,
        approvedAt: new Date().toISOString(),
        runtimePath: result.runtimePath,
        auth: result.auth,
        accountLabel: result.accountLabel,
        scopeVersion: 1,
      };
      await changed();
      return status(input.harness);
    },
  );
  register(
    "connection:disconnect",
    z.object({ harness: id }).strict(),
    async ({ harness }) => {
      if (
        state().tasks.some(
          (t) =>
            t.harness === harness &&
            ["preparing", "running", "stopping"].includes(t.run.state),
        )
      )
        throw Error(
          "Stop this adapter's active workers before disconnecting it.",
        );
      delete state().workerConnections?.[harness as Harness];
      await changed();
    },
  );
  register("account:status", z.undefined(), () => account.refresh());
  register("account:sign-in", z.undefined(), () => account.signIn());
  return { account, close: () => account.close() };
}
