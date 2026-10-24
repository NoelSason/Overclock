/**
 * In-page DOM extraction. `extractDom` runs inside the browser via page.evaluate and must be
 * self-contained (no references to anything outside its body). It returns a compact,
 * accessibility-oriented description of the page: controls with accessible names, forms,
 * tables, dialogs, label/value facts, headings, and bounded visible text.
 */

export interface RawControl {
  idx: number;
  role: string;
  name: string;
  tag: string;
  type?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  param?: string;
  value?: string;
  options?: { value: string; label: string }[];
  href?: string;
  formIdx?: number;
  region?: string;
  inDialog?: boolean;
  tabPanel?: string;
  disabled?: boolean;
  visible: boolean;
  cssPath: string;
  rect: { x: number; y: number; w: number; h: number };
}

export interface RawForm {
  idx: number;
  name?: string;
  action?: string;
  method: string;
  fieldIdx: number[];
  submitIdx: number[];
  cssPath: string;
}

export interface RawTable {
  idx: number;
  caption?: string;
  headers: string[];
  rowCount: number;
  sampleRows: string[][];
  linkHeaders: string[];
  sampleLinks: string[];
  cssPath: string;
}

export interface RawDialog {
  idx: number;
  title: string;
  text: string;
  controlIdx: number[];
  open: boolean;
}

export interface RawDom {
  url: string;
  title: string;
  headings: string[];
  controls: RawControl[];
  forms: RawForm[];
  tables: RawTable[];
  dialogs: RawDialog[];
  facts: { label: string; value: string; cssPath: string; xpath: string }[];
  text: string;
}

export function extractDom(opts: { maxText: number; maxControls: number; scopeSelector?: string | null }): RawDom {
  const root: Element = (opts.scopeSelector ? document.querySelector(opts.scopeSelector) : null) ?? document.body;
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const cssPath = (el: Element): string => {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement && parts.length < 8) {
      if (cur.id && document.querySelectorAll(`#${CSS.escape(cur.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const tag = cur.tagName.toLowerCase();
      const parent: Element | null = cur.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(cur) + 1})` : tag);
      cur = parent;
    }
    return parts.join(" > ");
  };
  const isVisible = (el: Element): boolean => {
    const he = el as HTMLElement;
    if (he.hidden || he.closest("[hidden]")) return false;
    const st = getComputedStyle(he);
    if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
    const r = he.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const labelOf = (el: Element): string => {
    const he = el as HTMLInputElement;
    const lb = he.labels?.[0];
    if (lb) return clean(lb.innerText || lb.textContent);
    const by = el.getAttribute("aria-labelledby");
    if (by) return clean(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
    return "";
  };
  const implicitRole = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "button") return "button";
    if (tag === "select") return (el as HTMLSelectElement).multiple ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "summary") return "button";
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
      if (type === "search") return "searchbox";
      if (type === "number") return "spinbutton";
      if (type === "hidden") return "hidden";
      return "textbox";
    }
    return "generic";
  };
  const nameOf = (el: Element, role: string): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const lb = labelOf(el);
    if (lb) return lb;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const t = (el.getAttribute("type") ?? "").toLowerCase();
      if (t === "submit" || t === "button") return clean((el as HTMLInputElement).value);
      return clean(el.getAttribute("placeholder") ?? el.getAttribute("title") ?? "");
    }
    if (role === "button" || role === "link" || role === "tab" || role === "menuitem" || role === "option") return clean((el as HTMLElement).innerText || el.textContent).slice(0, 120);
    return clean(el.getAttribute("title") ?? "");
  };
  const regionOf = (el: Element): string => {
    const dlg = el.closest("[role=dialog],[role=alertdialog],dialog");
    if (dlg) {
      const t = dlg.getAttribute("aria-label") || (dlg.getAttribute("aria-labelledby") ? document.getElementById(dlg.getAttribute("aria-labelledby")!)?.textContent : "") || dlg.querySelector("h1,h2,h3")?.textContent;
      return `dialog:${clean(t)}`;
    }
    const fs = el.closest("fieldset");
    if (fs?.querySelector("legend")) return `fieldset:${clean(fs.querySelector("legend")!.textContent)}`;
    const landmark = el.closest("nav,header,footer,aside,form,section,[role=navigation],[role=search],[role=tabpanel]");
    if (landmark) {
      const lbl = landmark.getAttribute("aria-label") || landmark.querySelector("h1,h2,h3,legend,caption")?.textContent || "";
      return `${landmark.getAttribute("role") ?? landmark.tagName.toLowerCase()}:${clean(lbl).slice(0, 60)}`;
    }
    return "main";
  };

  const forms = Array.from(document.forms).filter((f) => root.contains(f));
  const sel = "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=combobox],[role=menuitem],[role=switch],[contenteditable=true]";
  const els = Array.from(root.querySelectorAll(sel)).slice(0, opts.maxControls);
  const controls: RawControl[] = [];
  const idxOf = new Map<Element, number>();
  for (const el of els) {
    const role = el.getAttribute("role") ?? implicitRole(el);
    if (role === "hidden" || role === "generic") continue;
    const he = el as HTMLElement & { disabled?: boolean };
    const tabPanelEl = el.closest("[role=tabpanel]");
    const tabHidden = tabPanelEl && (tabPanelEl.hasAttribute("hidden") || !isVisible(tabPanelEl));
    const tabName = tabHidden ? clean(tabPanelEl!.getAttribute("aria-label") || (tabPanelEl!.getAttribute("aria-labelledby") ? document.getElementById(tabPanelEl!.getAttribute("aria-labelledby")!)?.textContent : "") || "") : "";
    const c: RawControl = {
      idx: controls.length,
      role,
      name: nameOf(el, role),
      tag: el.tagName.toLowerCase(),
      visible: isVisible(el),
      cssPath: cssPath(el),
      rect: (() => {
        const r = he.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      })(),
    };
    const type = el.getAttribute("type");
    if (type) c.type = type.toLowerCase();
    const lb = labelOf(el);
    if (lb) c.label = lb;
    const ph = el.getAttribute("placeholder");
    if (ph) c.placeholder = ph;
    const tid = el.getAttribute("data-testid");
    if (tid) c.testId = tid;
    const param = el.getAttribute("name");
    if (param) c.param = param;
    if (el instanceof HTMLSelectElement) {
      c.options = Array.from(el.options).map((o) => ({ value: o.value, label: clean(o.textContent) }));
      c.value = el.value;
    } else if (el instanceof HTMLInputElement) {
      c.value = el.type === "checkbox" || el.type === "radio" ? String(el.checked) : el.type === "password" ? "" : el.value.slice(0, 120);
    } else if (el instanceof HTMLTextAreaElement) c.value = el.value.slice(0, 120);
    const href = el.getAttribute("href");
    if (href) c.href = href;
    const form = (el as HTMLInputElement).form ?? el.closest("form");
    if (form) c.formIdx = forms.indexOf(form as HTMLFormElement);
    c.region = regionOf(el);
    if (el.closest("[role=dialog],[role=alertdialog],dialog")) c.inDialog = true;
    if (tabName) c.tabPanel = tabName;
    if (he.disabled || el.getAttribute("aria-disabled") === "true") c.disabled = true;
    idxOf.set(el, c.idx);
    controls.push(c);
  }

  const rawForms: RawForm[] = forms.map((f, i) => {
    const members = Array.from(f.elements);
    const fieldIdx: number[] = [];
    const submitIdx: number[] = [];
    for (const m of members) {
      const k = idxOf.get(m);
      if (k === undefined) continue;
      const t = (m.getAttribute("type") ?? "").toLowerCase();
      if ((m.tagName === "BUTTON" && t !== "button" && t !== "reset") || t === "submit") submitIdx.push(k);
      else if (m.tagName !== "BUTTON") fieldIdx.push(k);
    }
    const r: RawForm = { idx: i, method: (f.getAttribute("method") ?? "get").toLowerCase(), fieldIdx, submitIdx, cssPath: cssPath(f) };
    const name = f.getAttribute("aria-label") ?? f.getAttribute("name");
    if (name) r.name = name;
    const action = f.getAttribute("action");
    if (action) r.action = action;
    return r;
  });

  const tables: RawTable[] = Array.from(root.querySelectorAll("table")).map((t, i) => {
    let headerCells = Array.from(t.querySelectorAll("thead th"));
    if (!headerCells.length) headerCells = Array.from(t.querySelectorAll("tr:first-child th"));
    const headers = headerCells.map((h) => clean((h as HTMLElement).innerText || h.textContent));
    const rows = Array.from(t.tBodies.length ? t.tBodies[0]!.rows : t.rows).filter((r) => r.querySelectorAll("td").length > 0);
    const linkHeaders = new Set<string>();
    const sampleLinks: string[] = [];
    for (const r of rows.slice(0, 3)) {
      Array.from(r.cells).forEach((cell, ci) => {
        const a = cell.querySelector("a[href]");
        if (a && headers[ci]) {
          linkHeaders.add(headers[ci]!);
          if (sampleLinks.length < 3) sampleLinks.push(a.getAttribute("href")!);
        }
      });
    }
    const r: RawTable = {
      idx: i,
      headers,
      rowCount: rows.length,
      sampleRows: rows.slice(0, 3).map((r) => Array.from(r.cells).map((c) => clean((c as HTMLElement).innerText || c.textContent).slice(0, 60))),
      linkHeaders: [...linkHeaders],
      sampleLinks,
      cssPath: cssPath(t),
    };
    const cap = t.querySelector("caption")?.textContent ?? t.getAttribute("aria-label");
    if (cap) r.caption = clean(cap);
    return r;
  });

  const dialogs: RawDialog[] = Array.from(document.querySelectorAll("[role=dialog],[role=alertdialog],dialog")).map((d, i) => {
    const title = clean(d.getAttribute("aria-label") || (d.getAttribute("aria-labelledby") ? document.getElementById(d.getAttribute("aria-labelledby")!)?.textContent : "") || d.querySelector("h1,h2,h3")?.textContent || "");
    const open = d.tagName === "DIALOG" ? (d as HTMLDialogElement).open : isVisible(d);
    return { idx: i, title, text: clean((d as HTMLElement).innerText || d.textContent).slice(0, 400), controlIdx: Array.from(d.querySelectorAll(sel)).map((e) => idxOf.get(e)).filter((x): x is number => x !== undefined), open };
  });

  const facts: RawDom["facts"] = [];
  for (const dt of Array.from(root.querySelectorAll("dt"))) {
    const dd = dt.nextElementSibling;
    if (!dd || dd.tagName !== "DD") continue;
    const label = clean(dt.textContent);
    if (!label) continue;
    const scope = dt.closest("section,article,[role=region]")?.querySelector("h2,h3")?.textContent;
    facts.push({ label: scope ? `${clean(scope)} › ${label}` : label, value: clean((dd as HTMLElement).innerText || dd.textContent).slice(0, 200), cssPath: cssPath(dd), xpath: `//dt[normalize-space()=${JSON.stringify(label)}]/following-sibling::dd[1]` });
  }
  // Vertical key/value tables: <tr><th>Label</th><td>Value</td></tr>
  for (const tr of Array.from(root.querySelectorAll("tr"))) {
    const cells = tr.children;
    if (cells.length !== 2 || cells[0]!.tagName !== "TH" || cells[1]!.tagName !== "TD") continue;
    const label = clean(cells[0]!.textContent);
    if (label) facts.push({ label, value: clean((cells[1] as HTMLElement).innerText).slice(0, 200), cssPath: cssPath(cells[1]!), xpath: `//tr/th[normalize-space()=${JSON.stringify(label)}]/following-sibling::td[1]` });
  }

  const headings = Array.from(root.querySelectorAll("h1,h2,h3")).map((h) => clean(h.textContent)).filter(Boolean).slice(0, 20);
  const main = document.querySelector("main") ?? root;
  return {
    url: location.href,
    title: document.title,
    headings,
    controls,
    forms: rawForms,
    tables,
    dialogs,
    facts,
    text: clean((main as HTMLElement).innerText).slice(0, opts.maxText),
  };
}
