import type { AgentKey, AgentObservation } from "@overclock/contracts";
import { clickElement, fetchText, locate, readText, settle, snapshot } from "./page";

/**
 * Drives one tab in the user's own browser through the extension debugger API (the Chrome
 * DevTools Protocol), so clicks and keys are real input events that any site accepts, including
 * editors such as Google Docs that ignore synthetic events. The browser shows a bar while the
 * extension is attached; closing it, or the tab, stops the task.
 *
 * Page reading runs in an isolated world: the page's scripts can't see or change Overclock's
 * element map.
 */

interface Target {
  tabId: number;
}
interface DebuggerApi {
  attach(target: Target, version: string): Promise<void>;
  detach(target: Target): Promise<void>;
  sendCommand(target: Target, method: string, params?: object): Promise<unknown>;
  onEvent: { addListener(f: (source: Target, method: string, params?: unknown) => void): void; removeListener(f: (source: Target, method: string, params?: unknown) => void): void };
  onDetach: { addListener(f: (source: Target, reason: string) => void): void; removeListener(f: (source: Target, reason: string) => void): void };
}
/** `debugger` is a reserved word, so it can't be declared as a namespace in chrome.d.ts. */
const cdp = (): DebuggerApi => (globalThis as unknown as { chrome: { debugger: DebuggerApi } }).chrome.debugger;

const KEYS: Record<AgentKey, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
};

const SNAPSHOT_LIMITS = { maxText: 12_000, maxElements: 300 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TabDriver {
  private world: number | null = null;
  private attached = false;

  private readonly onEvent = (source: Target, method: string, params?: unknown) => {
    if (source.tabId !== this.tabId) return;
    if (method === "Page.frameNavigated" && !(params as { frame: { parentId?: string } }).frame.parentId) this.world = null;
    if (method === "Runtime.executionContextsCleared") this.world = null;
  };
  private readonly onDetach = (source: Target, reason: string) => {
    if (source.tabId !== this.tabId) return;
    this.attached = false;
    this.release();
    this.onGone(reason === "target_closed" ? "You closed Overclock's tab." : "Overclock was stopped from the browser's bar.");
  };

  private constructor(
    readonly tabId: number,
    private readonly onGone: (why: string) => void,
  ) {}

  /** Opens a new tab next to the current one, at `url`, and takes control of it. */
  static async open(url: string, onGone: (why: string) => void): Promise<TabDriver> {
    const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = await chrome.tabs.create({ url, active: true, ...(current ? { index: current.index + 1, windowId: current.windowId } : {}) });
    if (tab.id === undefined) throw new Error("The browser didn't open a tab.");
    const d = new TabDriver(tab.id, onGone);
    await d.attach();
    await d.waitForLoad(20_000);
    return d;
  }

  private async attach(): Promise<void> {
    cdp().onEvent.addListener(this.onEvent);
    cdp().onDetach.addListener(this.onDetach);
    await cdp().attach({ tabId: this.tabId }, "1.3");
    this.attached = true;
    await this.send("Page.enable");
  }

  private release(): void {
    cdp().onEvent.removeListener(this.onEvent);
    cdp().onDetach.removeListener(this.onDetach);
  }

  async detach(): Promise<void> {
    this.release();
    if (!this.attached) return;
    this.attached = false;
    await cdp()
      .detach({ tabId: this.tabId })
      .catch(() => undefined);
  }

  private async send<T = unknown>(method: string, params?: object): Promise<T> {
    if (!this.attached) throw new Error("Overclock no longer controls this tab.");
    return (await cdp().sendCommand({ tabId: this.tabId }, method, params)) as T;
  }

  private async isolatedWorld(): Promise<number> {
    if (this.world !== null) return this.world;
    const { frameTree } = await this.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
    const { executionContextId } = await this.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "overclock" });
    this.world = executionContextId;
    return executionContextId;
  }

  /** Calls one of the self-contained functions in page.ts inside the tab's isolated world. */
  private async run<A, R>(fn: (args: A) => R, args: A): Promise<Awaited<R>> {
    for (let attempt = 0; ; attempt++) {
      const contextId = await this.isolatedWorld();
      try {
        const r = await this.send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", {
          expression: `(${fn.toString()})(${JSON.stringify(args)})`,
          contextId,
          returnByValue: true,
          awaitPromise: true,
        });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split("\n")[0] ?? r.exceptionDetails.text);
        return r.result.value as Awaited<R>;
      } catch (err) {
        // The page navigated and took the world with it: make a new one and try once more.
        if (attempt === 0 && /context/i.test(String(err))) {
          this.world = null;
          continue;
        }
        throw err;
      }
    }
  }

  /** Waits for the document to load, then for the page to stop changing. */
  private async waitForLoad(maxMs: number): Promise<void> {
    const end = Date.now() + maxMs;
    while (Date.now() < end) {
      const r = await this.send<{ result: { value?: unknown } }>("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }).catch(() => null);
      if (r?.result.value === "complete") break;
      await sleep(150);
    }
    await this.run(settle, { quietMs: 400, maxMs: 3_000 }).catch(() => undefined);
  }

  /** After an action: a beat for any navigation to start, then the same wait as a load. */
  private async afterAction(): Promise<void> {
    await sleep(350);
    await this.waitForLoad(10_000);
  }

  async snapshot(): Promise<AgentObservation> {
    return this.run(snapshot, SNAPSHOT_LIMITS);
  }

  async navigate(url: string): Promise<void> {
    const r = await this.send<{ errorText?: string }>("Page.navigate", { url });
    if (r.errorText) throw new Error(`The page didn't open (${r.errorText}).`);
    this.world = null;
    await this.waitForLoad(20_000);
  }

  private async mouseClick(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async click(ref: string): Promise<void> {
    const at = await this.run(locate, { ref, focus: false });
    if (!at.ok) throw new Error(at.reason);
    if (at.clickable) await this.mouseClick(at.x, at.y);
    else if (!(await this.run(clickElement, { ref }))) throw new Error(`Element ${ref} is gone: the page changed.`);
    await this.afterAction();
  }

  async press(key: AgentKey): Promise<void> {
    const k = KEYS[key];
    const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
    await this.send("Input.dispatchKeyEvent", { ...base, type: k.text ? "keyDown" : "rawKeyDown", ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
    await this.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  }

  /**
   * Types into an element (replacing a field's text) or at the cursor. Each newline is an Enter
   * key press, which starts a new paragraph in documents and a new line in text areas.
   */
  async type(ref: string | undefined, text: string): Promise<void> {
    if (ref) {
      const at = await this.run(locate, { ref, focus: true });
      if (!at.ok) throw new Error(at.reason);
      if (!at.editable) throw new Error(`Element ${ref} isn't a field you can type in.`);
      // A click puts the cursor in rich editors; fields were focused and their text selected.
      if (at.clickable && !at.singleLine) await this.mouseClick(at.x, at.y);
    }
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    for (const [i, line] of lines.entries()) {
      if (line) await this.send("Input.insertText", { text: line });
      if (i < lines.length - 1) await this.press("Enter");
    }
    await this.afterAction();
  }

  async scroll(direction: "down" | "up"): Promise<void> {
    const r = await this.send<{ result: { value?: [number, number] } }>("Runtime.evaluate", { expression: "[innerWidth, innerHeight]", returnByValue: true });
    const [w, h] = r.result.value ?? [800, 600];
    await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: w / 2, y: h / 2, deltaX: 0, deltaY: (direction === "down" ? 1 : -1) * h * 0.8 });
    await this.afterAction();
  }

  async read(ref: string | undefined): Promise<string> {
    return this.run(readText, { ...(ref ? { ref } : {}), max: 50_000 });
  }

  /** Fetches an address on the tab's own site with the user's session (no navigation). */
  async fetchText(url: string): Promise<{ ok: boolean; status: number; text: string }> {
    return this.run(fetchText, { url });
  }

  async currentUrl(): Promise<string> {
    const r = await this.send<{ result: { value?: string } }>("Runtime.evaluate", { expression: "location.href", returnByValue: true });
    return r.result.value ?? "";
  }

  async wait(seconds: number): Promise<void> {
    await sleep(Math.min(10, Math.max(1, seconds)) * 1000);
    await this.waitForLoad(5_000);
  }
}
