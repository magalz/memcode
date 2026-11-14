import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserReply, BrowserRequest } from "../browser";
import { errorMessage } from "../errors";

export function useWorkerBrowser(taskId: string, obscured: boolean) {
  const [view, setView] = useState<BrowserReply | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(0);
  const alive = useRef(true),
    frame = useRef<Promise<void> | null>(null);
  const accept = useCallback((reply: BrowserReply) => {
    if (!alive.current) return;
    setView((previous) => ({
      ...reply,
      image:
        reply.image ??
        (reply.state.tabs.find((tab) => tab.active)?.id ===
        previous?.state.tabs.find((tab) => tab.active)?.id
          ? previous?.image
          : undefined),
    }));
  }, []);
  const refresh = useCallback(() => {
    frame.current ??= window.memcode
      .browser(taskId, { action: "state" })
      .then((reply) =>
        reply.state.nativeSurface
          ? reply
          : window.memcode.browser(taskId, { action: "frame" }),
      )
      .then(accept)
      .catch((error) => {
        if (alive.current) setError(errorMessage(error));
      })
      .finally(() => {
        frame.current = null;
      });
    return frame.current;
  }, [taskId, accept]);
  useEffect(() => {
    alive.current = true;
    void window.memcode.hidePreview().catch(() => {});
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!obscured && document.visibilityState !== "hidden") await refresh();
      if (!stopped) timer = setTimeout(poll, 900);
    };
    void poll();
    return () => {
      stopped = true;
      alive.current = false;
      clearTimeout(timer);
    };
  }, [refresh, obscured]);
  const send = useCallback(
    async (request: BrowserRequest, takeControl = false) => {
      const quiet =
        request.action === "surface" ||
        (request.action === "act" && request.input.action === "hover");
      if (!quiet) {
        setPending((count) => count + 1);
        setError("");
      }
      try {
        if (takeControl)
          await window.memcode.browser(taskId, {
            action: "control",
            value: "user",
          });
        const reply = await window.memcode.browser(taskId, request);
        accept(reply);
        if (!quiet && !["state", "frame"].includes(request.action))
          await refresh();
        return reply;
      } catch (error) {
        if (alive.current && !quiet) setError(errorMessage(error));
        if (!quiet) await refresh();
      } finally {
        if (alive.current && !quiet)
          setPending((count) => Math.max(0, count - 1));
      }
    },
    [taskId, accept, refresh],
  );
  return { view, error, pending: pending > 0, send };
}
