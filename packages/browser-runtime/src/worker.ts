import type { BrowserContext, Page } from "playwright";
import type { WorkerState } from "@overclock/contracts";
import { trackActivity } from "./browser";

export interface WorkerStateInfo {
  taskId?: string | undefined;
  app?: string | undefined;
  op?: string | undefined;
  label?: string | undefined;
}

export type WorkerStateListener = (worker: BrowserWorker, state: WorkerState, info: WorkerStateInfo) => void;

/**
 * A browser worker: one isolated context with one warm page per application. Workers do not
 * reason; they execute validated segments handed to them by the scheduler.
 */
export class BrowserWorker {
  state: WorkerState = "IDLE";
  info: WorkerStateInfo = {};
  private readonly pages = new Map<string, Page>();
  nativeDialogs = 0;
  lastApp: string | undefined;
  closed = false;

  constructor(
    readonly id: string,
    readonly context: BrowserContext,
    readonly apps: ReadonlyMap<string, string>,
    private readonly listener: WorkerStateListener,
  ) {}

  originOf(app: string): string {
    const o = this.apps.get(app);
    if (!o) throw new Error(`Unknown application "${app}"`);
    return o;
  }

  async pageFor(app: string): Promise<Page> {
    let page = this.pages.get(app);
    if (page && !page.isClosed()) {
      this.lastApp = app;
      return page;
    }
    page = await this.context.newPage();
    trackActivity(page);
    page.setDefaultTimeout(10_000);
    // Native confirm/alert dialogs are dismissed (the safe default) and counted as interference.
    page.on("dialog", (d) => {
      this.nativeDialogs++;
      void d.dismiss().catch(() => undefined);
    });
    this.pages.set(app, page);
    this.lastApp = app;
    return page;
  }

  currentPage(): Page | undefined {
    return this.lastApp ? this.pages.get(this.lastApp) : undefined;
  }

  setState(state: WorkerState, info: WorkerStateInfo = {}): void {
    this.state = state;
    this.info = info;
    this.listener(this, state, info);
  }

  async thumbnail(): Promise<Buffer | null> {
    const page = this.currentPage();
    if (!page || page.isClosed()) return null;
    try {
      return await page.screenshot({ type: "jpeg", quality: 45, scale: "css", timeout: 1500, animations: "disabled", caret: "hide" });
    } catch {
      return null;
    }
  }

  /** Simulate a crash for fault-injection tests: tear down every page mid-flight. */
  async crash(): Promise<void> {
    for (const p of this.pages.values()) await p.close({ runBeforeUnload: false }).catch(() => undefined);
    this.pages.clear();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.context.close().catch(() => undefined);
    this.setState("STOPPED");
  }
}
