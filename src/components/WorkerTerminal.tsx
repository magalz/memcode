import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import "../styles-terminal.css";
import { ArrowUpRight, Plus, Square, Terminal, X } from "lucide-react";
import { Select } from "./Select";
import { terminalCopyShortcut } from "../platform";
import type { WorkItem } from "../shared";
import type { ReviewReference, ReviewComment } from "../review";
import { SelectionActions } from "./SelectionActions";
import { ReviewHighlights } from "./ReviewHighlights";
import type {
  TerminalOutput,
  TerminalSession,
  TerminalShell,
} from "../terminal";

export function WorkerTerminal({
  task,
  onBrowser,
  onComment,
  comments,
  focusedCommentId,
  focusVersion,
  onFocusComment,
}: {
  task: WorkItem;
  onBrowser: (url: string) => void;
  onComment: (reference: ReviewReference) => void;
  comments: ReviewComment[];
  focusedCommentId?: string;
  focusVersion?: number;
  onFocusComment: (id: string) => void;
}) {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [shells, setShells] = useState<TerminalShell[]>([]);
  const [shell, setShell] = useState("");
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<ReviewReference>();
  const current = sessions.find((s) => s.id === selected);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const reference = comments.find(
      (comment) => comment.id === focusedCommentId,
    )?.reference;
    if (reference?.sessionId) setSelected(reference.sessionId);
  }, [focusedCommentId, focusVersion]);
  useEffect(() => setSelection(undefined), [selected]);
  const refresh = useCallback(async () => {
    try {
      const result = await window.memcode.terminal(task.id, { action: "list" });
      setSessions(result.sessions);
      setShells(result.shells);
      setShell((value) => value || result.shells[0]?.id || "");
      setSelected((value) =>
        result.sessions.some((s) => s.id === value)
          ? value
          : (result.sessions.at(-1)?.id ?? ""),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }, [task.id]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [refresh]);
  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await window.memcode.terminal(task.id, {
        action: "start",
        shellId: shell,
        label: shells.find((s) => s.id === shell)?.name ?? "Terminal",
      });
      await refresh();
      setSelected(result.session!.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div ref={root} className="worker-terminal">
      <header className="terminal-toolbar">
        <div
          className="terminal-session-tabs"
          role="tablist"
          aria-label="Terminal sessions"
        >
          {sessions.map((session) => (
            <div
              className={
                "terminal-tab " + (selected === session.id ? "active" : "")
              }
              key={session.id}
            >
              <button
                role="tab"
                aria-selected={selected === session.id}
                onClick={() => setSelected(session.id)}
              >
                <i className={session.status} />
                <span>{session.label}</span>
                {session.origin === "worker" && <small>Worker</small>}
              </button>
              <button
                className="terminal-tab-close"
                aria-label={"Close " + session.label + " terminal"}
                title="Close terminal and stop its process"
                onClick={() => {
                  void window.memcode
                    .terminal(task.id, {
                      action: "close",
                      sessionId: session.id,
                    })
                    .then(refresh)
                    .catch((e) => setError(e.message));
                }}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
        <div className="terminal-actions">
          <SelectionActions selection={selection} onComment={onComment} />
          {shells.length > 0 && (
            <Select
              aria-label="Terminal shell"
              value={shell}
              onValueChange={setShell}
            >
              {shells.map((s) => (
                <option value={s.id} key={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
          <button
            className="icon-button"
            aria-label="New terminal"
            title="New terminal"
            disabled={busy || !shell}
            onClick={() => void start()}
          >
            <Plus size={15} />
          </button>
          {current?.status === "running" && (
            <button
              className="icon-button"
              aria-label="Stop terminal"
              title="Stop this process"
              onClick={() =>
                void window.memcode
                  .terminal(task.id, { action: "stop", sessionId: current.id })
                  .then(refresh)
                  .catch((e) => setError(e.message))
              }
            >
              <Square size={12} />
            </button>
          )}
        </div>
      </header>
      {error && (
        <div className="terminal-error" role="alert">
          {error}
          <button
            aria-label="Dismiss terminal error"
            onClick={() => setError("")}
          >
            <X size={12} />
          </button>
        </div>
      )}
      {current ? (
        <TerminalSurface
          key={current.id}
          taskId={task.id}
          session={current}
          onError={setError}
          onBrowser={onBrowser}
          onExit={refresh}
          onSelection={setSelection}
        />
      ) : (
        <div className="terminal-empty">
          <span>
            <Terminal size={25} />
          </span>
          <h3>A live terminal for this work.</h3>
          <p>
            Dev servers, watchers and interactive sessions appear here. You and
            the worker share the same running process.
          </p>
          <button
            className="primary-button"
            disabled={busy || !shell}
            onClick={() => void start()}
          >
            <Plus size={13} />
            Open terminal
          </button>
        </div>
      )}
      <footer className="terminal-status">
        <span>
          <i className={current?.status ?? ""} />
          {current
            ? current.status === "running"
              ? "Live · input goes to this process"
              : "Exited · code " + current.exitCode
            : "Local execution"}
        </span>
        <span title={current?.cwd}>
          {current?.cwd ?? "Routine tool commands stay in the conversation"}
        </span>
      </footer>
      <ReviewHighlights
        comments={comments.filter(
          (comment) => comment.reference.sessionId === selected,
        )}
        root={root}
        focusedId={focusedCommentId}
        focusVersion={focusVersion}
        onFocus={onFocusComment}
      />
    </div>
  );
}

function TerminalSurface({
  taskId,
  session,
  onError,
  onBrowser,
  onExit,
  onSelection,
}: {
  taskId: string;
  session: TerminalSession;
  onError: (s: string) => void;
  onBrowser: (url: string) => void;
  onExit: () => Promise<void>;
  onSelection: (reference: ReviewReference | undefined) => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const browser = useRef(onBrowser);
  browser.current = onBrowser;
  const fail = useRef(onError);
  fail.current = onError;
  const exit = useRef(onExit);
  exit.current = onExit;
  useEffect(() => {
    if (!mount.current) return;
    let disposed = false,
      ready = false,
      sequence = 0,
      pending: TerminalOutput[] = [],
      sending = Promise.resolve();
    const terminal = new XTerm({
      cursorBlink: true,
      cursorStyle: "bar",
      convertEol: false,
      scrollback: 10000,
      fontSize: 13,
      lineHeight: 1.45,
      fontWeight: "400",
      fontWeightBold: "600",
      fontFamily:
        '"Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
      theme: {
        background: "#0c1914",
        foreground: "#e4eee7",
        cursor: "#40dbc3",
        selectionBackground: "#276556",
        black: "#253b31",
        red: "#fa9b9b",
        green: "#95dfab",
        yellow: "#ebd28e",
        blue: "#88b7ec",
        magenta: "#d4a4ed",
        cyan: "#80dbe0",
        white: "#e4eee7",
        brightBlack: "#8b9d92",
        brightRed: "#ffb0b0",
        brightGreen: "#aff0c0",
        brightYellow: "#ffe0a0",
        brightBlue: "#a3c9f5",
        brightMagenta: "#e6c1f5",
        brightCyan: "#a1eff0",
        brightWhite: "#ffffff",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(
      new WebLinksAddon((event, url) => {
        event.preventDefault();
        try {
          const parsed = new URL(url);
          if (
            parsed.protocol === "https:" ||
            (parsed.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
          )
            browser.current(url);
        } catch {
          /* Ignore non-web terminal links. */
        }
      }),
    );
    terminal.open(mount.current);
    const selected = terminal.onSelectionChange(() => {
      const quote = terminal.getSelection().trim(),
        position = terminal.getSelectionPosition();
      onSelection(
        quote
          ? {
              kind: "terminal",
              selectionType: "terminal",
              taskId,
              name: session.label,
              sessionId: session.id,
              quote: quote.slice(0, 4000),
              location: position
                ? `Output rows ${position.start.y + 1}–${position.end.y + 1}`
                : "Terminal output",
              ...(position
                ? {
                    lineStart: position.start.y + 1,
                    lineEnd: position.end.y + 1,
                    columnStart: position.start.x,
                    columnEnd: position.end.x,
                  }
                : {}),
            }
          : undefined,
      );
    });
    const bytes = (data: string) =>
      Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const accept = (event: TerminalOutput) => {
      if (disposed || event.sessionId !== session.id || event.taskId !== taskId)
        return;
      if (!ready) {
        pending.push(event);
        return;
      }
      if (event.data && event.seq > sequence) {
        sequence = event.seq;
        terminal.write(bytes(event.data));
      }
      if (event.status === "exited") void exit.current();
    };
    const unsubscribe = window.memcode.onTerminal(accept);
    void window.memcode
      .terminal(taskId, { action: "observe", sessionId: session.id, after: 0 })
      .then((result) => {
        if (disposed) return;
        if (result.truncated)
          terminal.writeln(
            "\x1b[90mEarlier terminal output was trimmed from the local buffer.\x1b[0m",
          );
        for (const chunk of result.chunks ?? []) {
          terminal.write(bytes(chunk.data));
          sequence = chunk.seq;
        }
        ready = true;
        for (const event of pending) accept(event);
        pending = [];
      })
      .catch((e) => fail.current(e.message));
    terminal.onData((data) => {
      sending = sending
        .then(() =>
          window.memcode.terminal(taskId, {
            action: "write",
            sessionId: session.id,
            data,
          }),
        )
        .then(() => {})
        .catch((e) => fail.current(e.message));
    });
    terminal.attachCustomKeyEventHandler((event) => {
      if (
        event.type === "keydown" &&
        terminalCopyShortcut(event) &&
        terminal.hasSelection()
      ) {
        void navigator.clipboard.writeText(terminal.getSelection());
        return false;
      }
      return true;
    });
    let resizeTimer: ReturnType<typeof setTimeout>;
    const fitTerminal = () => {
      if (disposed) return;
      fit.fit();
      // Round down once more if font/DPI rounding leaves the last row outside the host.
      const height = mount.current!.clientHeight;
      const screen = mount
        .current!.querySelector(".xterm-screen")
        ?.getBoundingClientRect();
      if (screen && screen.height > height && terminal.rows > 5) {
        const rowHeight = screen.height / terminal.rows;
        terminal.resize(
          terminal.cols,
          Math.max(5, Math.floor(height / rowHeight)),
        );
      }
      void window.memcode
        .terminal(taskId, {
          action: "resize",
          sessionId: session.id,
          cols: Math.max(20, Math.min(400, terminal.cols)),
          rows: Math.max(5, Math.min(200, terminal.rows)),
        })
        .catch((e) => fail.current(e.message));
    };
    const resize = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitTerminal();
      }, 80);
    });
    resize.observe(mount.current);
    void document.fonts.ready.then(() => fitTerminal());
    const fontResize = () => fitTerminal();
    document.fonts.addEventListener("loadingdone", fontResize);
    const render = terminal.onRender(() => {
      mount.current
        ?.querySelectorAll<HTMLElement>(".xterm-rows>div")
        .forEach((row, index) => {
          const line = String(terminal.buffer.active.viewportY + index + 1);
          if (row.dataset.terminalRow !== line) row.dataset.terminalRow = line;
        });
      const bounds = mount.current
        ?.querySelector(".xterm-screen")
        ?.getBoundingClientRect();
      if (bounds && bounds.height > mount.current!.clientHeight) {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(fitTerminal, 0);
      }
    });
    requestAnimationFrame(() => {
      if (!disposed) {
        fitTerminal();
        terminal.focus();
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
      selected.dispose();
      clearTimeout(resizeTimer);
      resize.disconnect();
      render.dispose();
      document.fonts.removeEventListener("loadingdone", fontResize);
      terminal.dispose();
    };
  }, [taskId, session.id]);
  return (
    <div className="terminal-surface">
      <div
        className="terminal-mount"
        ref={mount}
        aria-label={session.label + " live terminal"}
      />
    </div>
  );
}
