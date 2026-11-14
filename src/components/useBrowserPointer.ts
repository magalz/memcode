import { useEffect, useRef, type RefObject } from "react";
import type { BrowserReply, BrowserRequest } from "../browser";
import { browserPoint } from "./browser-point";

export function useBrowserPointer(
  ref: RefObject<HTMLDivElement | null>,
  view: BrowserReply | null,
  send: (
    request: BrowserRequest,
    takeControl?: boolean,
  ) => Promise<BrowserReply | undefined>,
) {
  const latest = useRef(view);
  latest.current = view;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let hoverTimer: ReturnType<typeof setTimeout> | undefined,
      wheelTimer: ReturnType<typeof setTimeout> | undefined;
    let pointer = { x: 0, y: 0 },
      deltaY = 0;
    const point = () =>
      latest.current?.image
        ? browserPoint(
            latest.current.image,
            element.getBoundingClientRect(),
            pointer.x,
            pointer.y,
          )
        : null;
    const hover = (event: MouseEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
      if (hoverTimer) return;
      hoverTimer = setTimeout(() => {
        hoverTimer = undefined;
        const state = latest.current?.state,
          position = point();
        if (!position || (state?.workerConnected && state.control === "worker"))
          return;
        void send({ action: "act", input: { action: "hover", ...position } });
      }, 90);
    };
    const wheel = (event: WheelEvent) => {
      if (!latest.current?.image) return;
      event.preventDefault();
      event.stopPropagation();
      pointer = { x: event.clientX, y: event.clientY };
      deltaY += event.deltaY;
      if (wheelTimer) return;
      wheelTimer = setTimeout(() => {
        wheelTimer = undefined;
        const state = latest.current?.state,
          position = point(),
          amount = deltaY;
        deltaY = 0;
        if (position)
          void send(
            {
              action: "act",
              input: {
                action: "scroll",
                ...position,
                deltaY: Math.max(-4000, Math.min(4000, amount)),
              },
            },
            !!state?.workerConnected && state.control === "worker",
          );
      }, 60);
    };
    element.addEventListener("mousemove", hover);
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      clearTimeout(hoverTimer);
      clearTimeout(wheelTimer);
      element.removeEventListener("mousemove", hover);
      element.removeEventListener("wheel", wheel);
    };
  }, [ref, send]);
}
