/**
 * Functions that run inside the user's tab, in an isolated world (the page's own scripts can't
 * see their variables). Each is self-contained: it's sent as source text and called with JSON
 * arguments, so it must not reference anything outside itself.
 *
 * `snapshot` numbers the page's interactive elements (e1, e2, …) and keeps them in the world's
 * own map, so a later `locate` call in the same world can find the element the model chose.
 */

export interface SnapshotResult {
  url: string;
  title: string;
  text: string;
  elements: { ref: string; role: string; name: string; value?: string; href?: string; state?: string }[];
  scroll: { y: number; height: number; viewport: number };
}

export function snapshot(opts: { maxText: number; maxElements: number }): SnapshotResult {
  const refs = new Map<string, Element>();
  (globalThis as unknown as { __overclock: { refs: Map<string, Element> } }).__overclock = { refs };
  const ROLES = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "tab", "treeitem", "row", "slider", "spinbutton"]);
  const clean = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const roleOf = (el: Element): string | null => {
    const explicit = el.getAttribute("role");
    if (explicit && ROLES.has(explicit)) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el as HTMLInputElement).type;
      if (t === "hidden") return null;
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      if (t === "checkbox" || t === "radio") return t;
      if (t === "search") return "searchbox";
      return "textbox";
    }
    if ((el as HTMLElement).isContentEditable && !(el.parentElement as HTMLElement | null)?.isContentEditable) return "textbox";
    if (el.hasAttribute("onclick") || (el.getAttribute("tabindex") ?? "-1") !== "-1") return explicit ? null : "button";
    return null;
  };
  const nameOf = (el: Element): string => {
    const doc = el.ownerDocument;
    const label = el.getAttribute("aria-label");
    if (label) return clean(label, 200);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (clean(t, 200)) return clean(t, 200);
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      const lab = el.labels?.[0]?.textContent;
      if (clean(lab, 200)) return clean(lab, 200);
      const ph = el.getAttribute("placeholder") ?? el.getAttribute("title") ?? el.getAttribute("name");
      if (ph) return clean(ph, 200);
      if (el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type)) return clean(el.value, 200);
    }
    const text = clean((el as HTMLElement).innerText ?? el.textContent, 200);
    if (text) return text;
    return clean(el.getAttribute("title") ?? el.querySelector("img")?.getAttribute("alt") ?? "", 200);
  };
  const visible = (el: Element, win: Window): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return (el as HTMLElement).isContentEditable;
    const cs = win.getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  };
  const viewportH = window.innerHeight;
  const out: SnapshotResult["elements"] = [];
  const walk = (doc: Document, win: Window, offsetY: number) => {
    for (const el of Array.from(doc.querySelectorAll("*"))) {
      if (out.length >= opts.maxElements) return;
      if (el.tagName === "IFRAME") {
        try {
          const inner = (el as HTMLIFrameElement).contentDocument;
          const innerWin = (el as HTMLIFrameElement).contentWindow;
          if (inner && innerWin) walk(inner, innerWin, offsetY + el.getBoundingClientRect().top);
        } catch {
          // cross-origin frame: not readable
        }
        continue;
      }
      const role = roleOf(el);
      if (!role || !visible(el, win)) continue;
      const ref = `e${out.length + 1}`;
      refs.set(ref, el);
      const e: SnapshotResult["elements"][number] = { ref, role, name: nameOf(el) };
      const states: string[] = [];
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        if (el.checked) states.push("checked");
      } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) e.value = el.type === "password" ? (el.value ? "••••" : "") : clean(el.value, 200);
      else if (el instanceof HTMLSelectElement) e.value = clean(el.selectedOptions[0]?.textContent, 200);
      else if ((el as HTMLElement).isContentEditable) e.value = clean((el as HTMLElement).innerText, 300);
      if (el.getAttribute("aria-checked") === "true") states.push("checked");
      if (el.getAttribute("aria-selected") === "true") states.push("selected");
      if (el.getAttribute("aria-expanded") === "true") states.push("expanded");
      if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") states.push("disabled");
      const top = el.getBoundingClientRect().top + offsetY;
      if (top > viewportH || top < -viewportH) states.push("offscreen");
      if (states.length) e.state = states.join(",");
      if (el instanceof HTMLAnchorElement && el.href && !el.href.startsWith("javascript:")) e.href = el.href.slice(0, 300);
      out.push(e);
    }
  };
  walk(document, window, 0);
  const main = document.querySelector('[role="main"], main');
  const source = main && ((main as HTMLElement).innerText ?? "").trim().length > 200 ? (main as HTMLElement) : document.body;
  let text = ((source?.innerText ?? "") as string).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  if (text.length > opts.maxText) text = `${text.slice(0, opts.maxText)}\n… (cut off: use read for the rest)`;
  const scroller = document.scrollingElement ?? document.documentElement;
  return { url: location.href, title: document.title, text, elements: out, scroll: { y: scroller.scrollTop, height: scroller.scrollHeight, viewport: viewportH } };
}

/**
 * Scrolls the chosen element into view and returns its center in the top page's coordinates,
 * adding the offsets of same-origin frames it sits in. Elements too small to click (a document
 * editor's hidden input surface) are focused instead.
 */
export function locate(args: { ref: string; focus: boolean }): { ok: true; x: number; y: number; clickable: boolean; editable: boolean; singleLine: boolean } | { ok: false; reason: string } {
  const store = (globalThis as unknown as { __overclock?: { refs: Map<string, Element> } }).__overclock;
  const el = store?.refs.get(args.ref);
  if (!el) return { ok: false, reason: `There's no element ${args.ref} on this page now. Use an id from the current page.` };
  if (!el.isConnected) return { ok: false, reason: `Element ${args.ref} is gone: the page changed. Use an id from the current page.` };
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  const r = el.getBoundingClientRect();
  let x = r.left + r.width / 2;
  let y = r.top + r.height / 2;
  let win: Window | null = el.ownerDocument.defaultView;
  while (win && win !== win.parent) {
    const frame = win.frameElement;
    if (!frame) break;
    const fr = frame.getBoundingClientRect();
    x += fr.left;
    y += fr.top;
    win = win.parent;
  }
  const isInput = el instanceof HTMLInputElement;
  const editable = el instanceof HTMLTextAreaElement || (isInput && !["button", "submit", "reset", "checkbox", "radio", "image", "file"].includes(el.type)) || (el as HTMLElement).isContentEditable;
  const clickable = r.width >= 2 && r.height >= 2 && x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
  if (args.focus) {
    (el as HTMLElement).focus?.();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
  }
  return { ok: true, x, y, clickable, editable, singleLine: isInput };
}

/** The full text of the page, or of one element. */
export function readText(args: { ref?: string; max: number }): string {
  const store = (globalThis as unknown as { __overclock?: { refs: Map<string, Element> } }).__overclock;
  const el = args.ref ? store?.refs.get(args.ref) : document.body;
  if (!el) return `There's no element ${args.ref ?? ""} on this page now.`;
  const text = ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return text.length > args.max ? `${text.slice(0, args.max)}\n… (cut off)` : text;
}

/** Resolves once the page has gone quiet (no DOM changes for `quietMs`), or after `maxMs`. */
export function settle(args: { quietMs: number; maxMs: number }): Promise<boolean> {
  return new Promise((resolve) => {
    let timer = setTimeout(done, args.quietMs);
    const cap = setTimeout(() => finish(false), args.maxMs);
    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, args.quietMs);
    });
    obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    function done() {
      finish(true);
    }
    function finish(quiet: boolean) {
      clearTimeout(timer);
      clearTimeout(cap);
      obs.disconnect();
      resolve(quiet);
    }
  });
}

/** Clicks an element from script, for elements too small or hidden to click with the mouse. */
export function clickElement(args: { ref: string }): boolean {
  const el = (globalThis as unknown as { __overclock?: { refs: Map<string, Element> } }).__overclock?.refs.get(args.ref);
  if (!el?.isConnected) return false;
  (el as HTMLElement).click();
  return true;
}

/** Fetches a same-site address with the user's session, as the page itself would (for reading a document back). */
export async function fetchText(args: { url: string }): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const res = await fetch(args.url, { credentials: "include" });
    return { ok: res.ok, status: res.status, text: (await res.text()).slice(0, 200_000) };
  } catch (err) {
    return { ok: false, status: 0, text: String(err) };
  }
}
