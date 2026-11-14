import { useEffect, type RefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import type { BrowserReply, BrowserRequest } from "../browser";

export function useNativeBrowserSurface(
  ref: RefObject<HTMLDivElement | null>,
  taskId: string,
  view: BrowserReply | null,
  obscured: boolean,
  send: (
    request: BrowserRequest,
    takeControl?: boolean,
  ) => Promise<BrowserReply | undefined>,
) {
  const native = view?.state.nativeSurface;
  const active = view?.state.tabs.find((tab) => tab.active);
  useEffect(() => {
    if (!native) return;
    const element = ref.current;
    if (!element) return;
    let popover = false,
      stopped = false;
    const show = () => {
      if (stopped) return;
      const rect = element.getBoundingClientRect();
      const visible =
        !!active &&
        active.url !== "about:blank" &&
        !active.url.startsWith("about:blank#") &&
        !obscured &&
        !popover &&
        document.visibilityState !== "hidden" &&
        rect.width > 10 &&
        rect.height > 10;
      void send({
        action: "surface",
        ...(active ? { tabId: active.id } : {}),
        visible,
        ...(visible
          ? {
              bounds: {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
              },
            }
          : {}),
      });
    };
    const menu = (event: Event) => {
      popover = (event as CustomEvent<boolean>).detail;
      show();
    };
    const observer = new ResizeObserver(show);
    observer.observe(element);
    window.addEventListener("resize", show);
    window.addEventListener("scroll", show, true);
    document.addEventListener("visibilitychange", show);
    window.addEventListener("memcode:popover", menu);
    show();
    return () => {
      stopped = true;
      observer.disconnect();
      window.removeEventListener("resize", show);
      window.removeEventListener("scroll", show, true);
      document.removeEventListener("visibilitychange", show);
      window.removeEventListener("memcode:popover", menu);
      void window.memcode
        .browser(taskId, { action: "surface", visible: false })
        .catch(() => {});
    };
  }, [ref, taskId, native, active?.id, active?.url, obscured, send]);
  useEffect(() => {
    if (
      !native ||
      !view?.state.workerConnected ||
      view.state.control !== "worker"
    )
      return;
    let taking = false;
    const enabledAt = Date.now();
    const subscription = listen<{ taskId: string; at?: number }>(
      "browser:native-input",
      (event) => {
        if (
          event.payload.taskId === taskId &&
          !taking &&
          (event.payload.at ?? Date.now()) >= enabledAt
        ) {
          taking = true;
          void send({ action: "control", value: "user" });
        }
      },
    );
    return () => {
      void subscription.then((unsubscribe) => unsubscribe());
    };
  }, [native, view?.state.workerConnected, view?.state.control, taskId, send]);
}
