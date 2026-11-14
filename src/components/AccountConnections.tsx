import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  RefreshCw,
  ShieldCheck,
  UserRound,
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
    [open, setOpen] = useState(!compact);
  const statusCallback = useRef(onStatus);
  statusCallback.current = onStatus;
  const refresh = useCallback(async () => {
    try {
      const next = await window.memcode.accountStatus();
      setAccount(next);
      statusCallback.current?.(next);
    } catch (error) {
      notify((error as Error).message);
    }
  }, [notify]);
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);
  useEffect(() => {
    if (!account?.loginPending || !open) return;
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [account?.loginPending, open, refresh]);
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
  const signIn = async () => {
    setBusy(true);
    try {
      const next = await window.memcode.signInMemtrace();
      setAccount(next);
      statusCallback.current?.(next);
      notify("Continue in your browser to sign in through Memtrace.");
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={"account-connections " + (compact ? "compact" : "")}>
      {compact && (
        <button
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
          <footer>
            <button
              className="secondary-button"
              onClick={() => void refresh()}
              disabled={busy}
            >
              <RefreshCw size={12} />
              Refresh
            </button>
            {account?.status !== "connected" && (
              <button
                className="primary-button"
                disabled={busy || account?.loginPending}
                onClick={() => void signIn()}
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
          </footer>
          {account?.loginPending && (
            <small className="account-login-hint">
              Complete the claim page in your system browser. MemCode will
              update when the CLI finishes signing in.{" "}
              {account.claimUrl && (
                <button
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
