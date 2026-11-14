import type { Browser, BrowserContext } from "playwright-core";
import { childEnv } from "../commands";
export interface BrowserSession {
  newPage: BrowserContext["newPage"];
  newCDPSession: BrowserContext["newCDPSession"];
  close(): Promise<void>;
  route(...args: Parameters<BrowserContext["route"]>): Promise<unknown>;
  onPage?(
    callback: (
      page: import("playwright-core").Page,
      replaces?: import("playwright-core").Page,
    ) => void,
  ): void;
}

/** One lazy browser process, with a separate storage/cookie context for every card. */
export class BrowserPool {
  readonly native = false;
  private opening?: Promise<Browser>;
  private browser?: Browser;
  async context(
    viewport: {
      width: number;
      height: number;
    },
    deviceScaleFactor = 1,
    _taskId = "",
  ): Promise<BrowserContext> {
    this.opening ??= (async () => {
      const { chromium } = await import("playwright-core");
      let first: unknown;
      for (const channel of ["msedge", "chrome"]) {
        try {
          const browser = await chromium.launch({
            channel,
            headless: true,
            chromiumSandbox: true,
            timeout: 20000,
            env: childEnv(),
          });
          this.browser = browser;
          browser.once("disconnected", () => {
            this.browser = undefined;
            this.opening = undefined;
          });
          return browser;
        } catch (error) {
          first ??= error;
        }
      }
      throw new Error(
        "Install Microsoft Edge or Google Chrome to use the shared worker browser. " +
          String(first),
      );
    })().catch((error) => {
      this.opening = undefined;
      throw error;
    });
    return (await this.opening).newContext({
      viewport,
      deviceScaleFactor,
      acceptDownloads: false,
      serviceWorkers: "block",
    });
  }
  connected(): boolean {
    return this.browser?.isConnected() ?? false;
  }
  async close(): Promise<void> {
    await (await this.opening?.catch(() => undefined))?.close();
  }
}
