import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  LogOut,
  RefreshCw,
  ShieldCheck,
  UserRound,
  UserRoundPen,
  X,
} from "lucide-react";
import type { MemtraceAccount } from "../connections";
import { Spinner } from "./UI";
import "../styles-connections.css";

export function AccountConnections({
  notify,
  compact = false,
  onStatus,
}: {
  notify: (text: string) => void;
  compact?: boolean;
  onStatus?: (account: MemtraceAccount) => void;
}) {
  const [account, setAccount] = useState<MemtraceAccount>(),
    [busy, setBusy] = useState(false),
    [refreshing, setRefreshing] = useState(false),
    [open, setOpen] = useState(!compact),
    [confirmation, setConfirmation] = useState<"sign-out" | "switch">();
  const statusCallback = useRef(onStatus);
  const requestVersion = useRef(0);
  const actionPending = useRef(false);
  statusCallback.current = onStatus;
  const refresh = useCallback(async () => {
    if (actionPending.current) return;
    const version = ++requestVersion.current;
    setRefreshing(true);
    try {
      const next = await window.memcode.accountStatus();
      if (version !== requestVersion.current) return;
      setAccount(next);
      statusCallback.current?.(next);
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [notify]);
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);
  useEffect(() => {
    if (!account?.loginPending || !open || busy) return;
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [account?.loginPending, open, busy, refresh]);
  useEffect(() => {
    if (!compact || !open) return;
    window.dispatchEvent(new CustomEvent("memcode:popover", { detail: true }));
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", escape);
      window.dispatchEvent(
        new CustomEvent("memcode:popover", { detail: false }),
      );
    };
  }, [compact, open]);
  const act = async (
    action: "sign-in" | "sign-out" | "switch" | "cancel",
  ) => {
    if (actionPending.current) return;
    actionPending.current = true;
    const version = ++requestVersion.current;
    setBusy(true);
    try {
      const next = await (action === "sign-in"
        ? window.memcode.signInMemtrace()
        : action === "sign-out"
          ? window.memcode.signOutMemtrace()
          : action === "switch"
            ? window.memcode.switchMemtraceAccount()
            : window.memcode.cancelMemtraceSignIn());
      if (version !== requestVersion.current) return;
      setAccount(next);
      statusCallback.current?.(next);
      setConfirmation(undefined);
      notify(
        action === "sign-out"
          ? "Signed out of Memtrace on this computer."
          : action === "cancel"
            ? "Memtrace sign-in cancelled."
            : "Continue in your browser and choose the Memtrace account to use.",
      );
    } catch (error) {
      notify((error as Error).message);
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  };
  const environmentManaged =
    account?.authMode === "environment" || !!account?.managedBy?.length;
  const canManage = account && account.status !== "unavailable" && !account.signedOut;
  return (
    <div className={"account-connections " + (compact ? "compact" : "")}>
      {compact && (
        <button
          type="button"
          className="account-trigger"
          aria-label="Memtrace account"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <UserRound size={14} />
        </button>
      )}
      {open && (
        <section
          className={compact ? "account-popover" : "account-panel"}
          role={compact ? "dialog" : "region"}
          aria-label="Memtrace account"
        >
          <header>
            <ShieldCheck size={17} />
            <div>
              <strong>Your Memtrace account.</strong>
              <small>One session. No separate MemCode account.</small>
            </div>
            {compact && (
              <button
                type="button"
                className="icon-button"
                aria-label="Close Memtrace account"
                onClick={() => setOpen(false)}
              >
                <X size={14} />
              </button>
            )}
          </header>
          <div
            className={
              "account-status " +
              (account?.status === "connected" ? "connected" : "")
            }
          >
            <span />
            <strong>{account?.label ?? "Checking Memtrace…"}</strong>
            {account?.loginPending && <Spinner />}
          </div>
          {account?.principal && (
            <p className="account-principal">
              {account.principal.name}
              <small>{account.principal.id}</small>
            </p>
          )}
          <p>
            {account?.status === "connected"
              ? "MemCode reuses the session managed by your installed Memtrace CLI."
              : "Sign in using Memtrace’s official browser flow. Your credentials stay with Memtrace."}
          </p>
          <details>
            <summary>Session details</summary>
            <p>{account?.detail ?? "Reading the installed Memtrace status."}</p>
            {account?.checkedAt && (
              <small>
                Checked{" "}
                {new Date(account.checkedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </small>
            )}
          </details>
          {environmentManaged && (
            <p className="account-session-note">
              This session is managed by{" "}
              <code>{account?.managedBy?.join(", ") || "the launch environment"}</code>.
              Remove the account override from the environment that starts
              MemCode, then restart it to use another account.
            </p>
          )}
          {account?.reconnectRequired && (
            <p className="account-session-note">
              Restart MemCode before starting workers. If Memtrace is running
              separately, restart that workspace too so it uses the selected
              account.
            </p>
          )}
          <footer>
            <button
              type="button"
              className="button secondary"
              onClick={() => void refresh()}
              disabled={busy || refreshing}
            >
              {refreshing ? <Spinner /> : <RefreshCw size={12} />}
              {refreshing ? "Checking…" : "Refresh"}
            </button>
            {account?.loginPending ? (
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => void act("cancel")}
              >
                Cancel sign-in
              </button>
            ) : account?.status !== "connected" && (
              <button
                type="button"
                className="button primary"
                disabled={busy || environmentManaged || account?.status === "unavailable"}
                onClick={() => void act("sign-in")}
              >
                {busy || account?.loginPending ? (
                  <Spinner />
                ) : (
                  <ArrowUpRight size={12} />
                )}{" "}
                {account?.loginPending
                  ? "Waiting for Memtrace…"
                  : "Sign in with Memtrace"}
              </button>
            )}
            {canManage && !account.loginPending && (
              <div className="account-session-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy || environmentManaged}
                  onClick={() => setConfirmation("switch")}
                >
                  <UserRoundPen size={12} />
                  Switch account
                </button>
                <button
                  type="button"
                  className="account-sign-out"
                  disabled={busy || environmentManaged}
                  onClick={() => setConfirmation("sign-out")}
                >
                  <LogOut size={12} />
                  Sign out
                </button>
              </div>
            )}
          </footer>
          {confirmation && (
            <div className="account-confirmation" role="group" aria-label="Confirm account change">
              <strong>
                {confirmation === "switch" ? "Use a different Memtrace account?" : "Sign out of Memtrace?"}
              </strong>
              <p>
                This changes the shared Memtrace CLI session on this computer.
                Your local projects, Team preview membership and coding-provider
                sign-ins stay in place.
              </p>
              {confirmation === "switch" && (
                <p>Choose the intended account in your browser. You may need to change its existing Memtrace website sign-in.</p>
              )}
              <div>
                <button type="button" className="button secondary" disabled={busy} onClick={() => setConfirmation(undefined)}>
                  Keep current account
                </button>
                <button type="button" className="button primary" disabled={busy} onClick={() => void act(confirmation)}>
                  {busy ? <Spinner /> : <ArrowUpRight size={12} />}
                  {confirmation === "switch" ? "Continue to sign in" : "Sign out"}
                </button>
              </div>
            </div>
          )}
          {account?.loginPending && (
            <small className="account-login-hint">
              Complete the claim page in your system browser. MemCode will
              update when the CLI finishes signing in.{" "}
              {account.claimUrl && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(account.claimUrl!)
                      .then(() => notify("Memtrace sign-in link copied."))
                  }
                >
                  Copy sign-in link
                </button>
              )}
            </small>
          )}
        </section>
      )}
    </div>
  );
}
