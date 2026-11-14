import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Globe2,
  Hand,
  History,
  Plus,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import type { WorkItem, Harness } from "../shared";
import { harnessNames } from "../shared";
import type { BrowserInteraction } from "../browser";
import { browserURL } from "../browser-address";
import { errorMessage, browserErrorMessage } from "../errors";
import { Empty, Spinner } from "./UI";
import { useWorkerBrowser } from "./useWorkerBrowser";
import { useBrowserPointer } from "./useBrowserPointer";
import { browserPoint } from "./browser-point";
import { useNativeBrowserSurface } from "./useNativeBrowserSurface";

export function WorkerBrowser({
  task,
  obscured,
  notify,
  opening,
  onOpeningConsumed,
}: {
  task: WorkItem;
  obscured: boolean;
  notify: (text: string) => void;
  opening?: { url: string; id: string };
  onOpeningConsumed?: () => void;
}) {
  const { view, error, pending, send } = useWorkerBrowser(task.id, obscured);
  const state = view?.state,
    active = state?.tabs.find((tab) => tab.active);
  const [address, setAddress] = useState("http://localhost:3000"),
    [addressError, setAddressError] = useState("");
  const [activity, setActivity] = useState(false);
  const addressRef = useRef<HTMLInputElement>(null),
    viewportRef = useRef<HTMLDivElement>(null),
    editing = useRef(false);
  const stateRef = useRef(state);
  const openedLink = useRef("");
  stateRef.current = state;
  useBrowserPointer(viewportRef, view, send);
  useNativeBrowserSurface(viewportRef, task.id, view, obscured, send);
  useEffect(() => {
    if (!opening || openedLink.current === opening.id) return;
    openedLink.current = opening.id;
    editing.current = true;
    setAddress(opening.url);
    setAddressError("");
    void send({ action: "open", url: opening.url }, true).then((reply) => {
      if (reply) editing.current = false;
    });
    onOpeningConsumed?.();
  }, [opening?.id, send]);
  useEffect(() => {
    if (active && !editing.current)
      setAddress(active.url === "about:blank" ? "" : active.url);
  }, [active?.url, active?.id]);
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (stateRef.current?.nativeSurface) return;
        const rect = element.getBoundingClientRect(),
          width = Math.max(640, Math.min(1920, Math.round(rect.width))),
          height = Math.max(400, Math.min(1200, Math.round(rect.height)));
        const current = stateRef.current?.viewport;
        if (
          current &&
          (Math.abs(current.width - width) > 1 ||
            Math.abs(current.height - height) > 1 ||
            stateRef.current?.deviceScaleFactor !==
              Math.min(2, window.devicePixelRatio))
        )
          void send({
            action: "resize",
            width,
            height,
            deviceScaleFactor: Math.min(2, window.devicePixelRatio),
          });
      }, 300);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [send]);
  const takeControl = !!state?.workerConnected && state.control === "worker";
  const act = (input: BrowserInteraction) =>
    void send({ action: "act", input }, takeControl);
  const navigate = (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const url = browserURL(address);
      setAddressError("");
      editing.current = false;
      setAddress(url.href);
      void send(
        {
          action: "open",
          url: url.href,
          ...(active ? { tabId: active.id } : {}),
        },
        takeControl,
      );
      addressRef.current?.blur();
    } catch (error) {
      setAddressError(errorMessage(error));
    }
  };
  const click = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!view?.image || !viewportRef.current) return;
    viewportRef.current.focus();
    const point = browserPoint(
      view.image,
      viewportRef.current.getBoundingClientRect(),
      event.clientX,
      event.clientY,
    );
    if (point) act({ action: "click", ...point });
  };
  const key = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!active) return;
    if (event.key === "Escape") {
      addressRef.current?.focus();
      return;
    }
    if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      act({ action: "type", text: event.key });
      return;
    }
    const value =
      (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a"
        ? event.metaKey
          ? "Meta+A"
          : "Control+A"
        : event.shiftKey && event.key === "Tab"
          ? "Shift+Tab"
          : event.key;
    if (
      [
        "Enter",
        "Tab",
        "Shift+Tab",
        "Backspace",
        "Delete",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "Control+A",
        "Meta+A",
      ].includes(value)
    ) {
      event.preventDefault();
      act({ action: "press", key: value as BrowserInteraction["key"] });
    }
  };
  return (
    <div className="browser-pane worker-browser">
      <div className="browser-tabline">
        <Globe2 size={12} />
        <span>
          {state?.workerConnected
            ? `${harnessNames[state.harness as Harness] ?? "Worker"}’s browser`
            : "Work item browser"}
        </span>
        <span className="browser-local-badge">
          {state?.workerConnected ? "LIVE SESSION" : "READY WHEN YOU ARE"}
        </span>
      </div>
      <div className="worker-browser-tabs" aria-label="Browser tabs">
        {state?.tabs.map((tab) => (
          <div
            className={"worker-browser-tab " + (tab.active ? "active" : "")}
            key={tab.id}
          >
            <button
              className="worker-browser-tab-select"
              onClick={() => act({ action: "select", tabId: tab.id })}
              title={tab.url}
            >
              <Globe2 size={11} />
              <span>{tab.title || "New tab"}</span>
            </button>
            <button
              aria-label={`Close ${tab.title || "tab"}`}
              onClick={() => act({ action: "close", tabId: tab.id })}
            >
              <X size={11} />
            </button>
          </div>
        ))}
        <button
          className="icon-button"
          aria-label="New browser tab"
          onClick={() => {
            void send({ action: "new-tab" }, takeControl);
            setAddress("");
            editing.current = true;
            addressRef.current?.focus();
          }}
        >
          <Plus size={13} />
        </button>
        {state?.workerConnected && (
          <button
            className="browser-control-owner"
            data-user={state.control === "user"}
            onClick={() =>
              void send({
                action: "control",
                value: state.control === "user" ? "worker" : "user",
              })
            }
          >
            <Hand size={11} />
            {state.control === "user" ? "Return to agent" : "Take control"}
          </button>
        )}
      </div>
      <form className="browser-controls" onSubmit={navigate}>
        <button
          type="button"
          className="icon-button"
          title="Back"
          disabled={!active}
          onClick={() => act({ action: "back" })}
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="Forward"
          disabled={!active}
          onClick={() => act({ action: "forward" })}
        >
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="Reload browser"
          disabled={!active}
          onClick={() => act({ action: "reload" })}
        >
          {pending ? <Spinner size={12} /> : <RefreshCw size={12} />}
        </button>
        <div className="browser-address">
          <ShieldCheck size={12} />
          <input
            ref={addressRef}
            aria-label="Browser address"
            placeholder="Website or localhost address"
            value={address}
            onFocus={() => {
              editing.current = true;
            }}
            onBlur={() => {
              editing.current = false;
            }}
            onChange={(event) => {
              setAddress(event.target.value);
              setAddressError("");
            }}
            spellCheck={false}
          />
          <button type="submit" title="Open browser address">
            <ArrowRight size={12} />
          </button>
        </div>
        <button
          type="button"
          className="icon-button"
          title="Save browser screenshot"
          disabled={!active}
          onClick={() =>
            void send({ action: "capture" }).then((reply) => {
              if (reply?.artifactId)
                notify(
                  "Browser screenshot saved to this work item’s artifacts.",
                );
            })
          }
        >
          <Camera size={14} />
        </button>
        <button
          type="button"
          className={"icon-button " + (activity ? "active" : "")}
          title="Browser activity"
          onClick={() => setActivity(!activity)}
        >
          <History size={14} />
        </button>
      </form>
      {(addressError || error || state?.error) && (
        <div className="browser-error" role="alert">
          {browserErrorMessage(addressError || error || state?.error)}
        </div>
      )}
      {state?.workerConnected && state.control === "user" && (
        <div className="browser-human-control">
          You have browser control. The worker can observe; its browser actions
          wait until you return control.
        </div>
      )}
      <div
        className="worker-browser-viewport"
        style={{ cursor: state?.cursor ?? "default" }}
        ref={viewportRef}
        tabIndex={active ? 0 : -1}
        aria-label={
          active
            ? `Interactive browser: ${active.title}. Escape returns to the address bar.`
            : "Work item browser"
        }
        onClick={click}
        onKeyDown={key}
        onPaste={(event) => {
          event.preventDefault();
          act({ action: "type", text: event.clipboardData.getData("text") });
        }}
      >
        {state?.nativeSurface &&
        active &&
        active.url !== "about:blank" &&
        !active.url.startsWith("about:blank#") ? (
          <div
            className="native-browser-surface"
            aria-label="Native interactive browser surface"
          />
        ) : view?.image && active?.url !== "about:blank" ? (
          <img
            draggable={false}
            alt={active?.title || "Current worker browser page"}
            src={`data:${view.image.mimeType};base64,${view.image.data}`}
          />
        ) : (
          <Empty
            icon={
              pending || state?.status === "starting" ? (
                <Spinner size={28} />
              ) : (
                <Globe2 size={28} />
              )
            }
            title={
              pending ? "Opening the browser…" : "The same page, together."
            }
            description="Open an HTTPS website or a local app. When the worker browses, its real tabs and page appear here."
            action={
              <button
                className="button secondary"
                onClick={(event) => {
                  event.stopPropagation();
                  addressRef.current?.focus();
                }}
              >
                Enter an address
                <ArrowRight size={13} />
              </button>
            }
          />
        )}
        {view?.image &&
          active?.url !== "about:blank" &&
          state?.pointer?.actor === "worker" && (
            <svg
              key={state.pointer.at}
              className="worker-browser-agent-pointer"
              viewBox={`0 0 ${view.image.width} ${view.image.height}`}
              preserveAspectRatio="xMidYMid meet"
              aria-label="Worker pointer"
            >
              <g transform={`translate(${state.pointer.x},${state.pointer.y})`}>
                <path d="M0 0 L0 19 L5 14 L9 23 L13 21 L9 12 L16 12 Z" />
              </g>
            </svg>
          )}
      </div>
      {activity && (
        <div className="worker-browser-activity">
          <div>
            Browser activity <span>{state?.activity.length ?? 0}</span>
          </div>
          {state?.activity.length ? (
            state.activity.map((entry, index) => (
              <p key={entry.at + index}>
                <time>
                  {new Date(entry.at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </time>
                <b>{entry.actor}</b>
                <span>{entry.text}</span>
              </p>
            ))
          ) : (
            <p>Real browser actions will appear here.</p>
          )}
        </div>
      )}
      <footer className="browser-footer">
        <ShieldCheck size={10} />
        Isolated session. Screenshots attach to this work item.
        <span>
          {state?.action ??
            (active
              ? "Click to interact · Esc returns to address"
              : "Browser starts on demand")}
        </span>
      </footer>
    </div>
  );
}
