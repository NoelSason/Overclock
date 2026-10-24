import type { AppControl, AppModel } from "@overclock/contracts";
import { routePattern } from "@overclock/perception";

function q(s: string | undefined): string {
  return JSON.stringify((s ?? "").slice(0, 80));
}

function hrefPattern(c: AppControl, origin: string): string {
  if (!c.detail) return "";
  try {
    const u = new URL(c.detail, origin);
    return routePattern(u.toString()) + (u.search ? u.search.replace(/=[^&]*/g, "=…") : "");
  } catch {
    return "";
  }
}

/**
 * Compact text rendering of an app model for planner prompts: every control appears with its
 * exact id so plans can only reference observed elements. Sample values are page data.
 */
export function renderAppModel(m: AppModel, opts: { samples?: boolean } = {}): string {
  const lines: string[] = [`APP ${m.app} — origin ${m.origin} (paths in plans are relative to this origin)`];
  for (const p of m.pages) {
    const controls = p.controlIds.map((id) => m.controls[id]).filter((c): c is AppControl => !!c);
    lines.push(`  PAGE ${p.routePattern}   example ${new URL(p.exampleUrl).pathname}${new URL(p.exampleUrl).search}   title ${q(p.title)}   load≈${p.loadMs.p50}ms`);
    if (p.headings.length) lines.push(`    headings: ${p.headings.slice(0, 6).map((h) => q(h)).join(", ")}`);
    const inForm = new Set<string>();
    for (const f of p.forms) {
      const fields = f.fieldIds.map((id) => m.controls[id]).filter((c): c is AppControl => !!c);
      const submits = f.submitIds.map((id) => m.controls[id]).filter((c): c is AppControl => !!c);
      fields.forEach((c) => inForm.add(c.id));
      submits.forEach((c) => inForm.add(c.id));
      lines.push(`    FORM ${f.method.toUpperCase()}${f.action ? ` action=${routePattern(new URL(f.action, m.origin).toString())}` : ""}`);
      for (const c of fields) {
        const extra = [
          c.param ? `param=${c.param}` : "",
          c.options ? `options=${c.options.map((o) => (o.value === o.label ? o.value : `${o.value}(${o.label})`)).join("|")}` : "",
          c.tabPanel ? `HIDDEN until tab ${q(c.tabPanel)} is clicked` : "",
          opts.samples !== false && c.sample !== undefined && c.sample !== "" ? `sample=${q(c.sample)}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        lines.push(`      [${c.id}] ${c.kind} ${q(c.label ?? c.name)} ${extra}`.trimEnd());
      }
      for (const c of submits) lines.push(`      [${c.id}] submit ${q(c.name)}${c.effectGuess ? ` effect=${c.effectGuess}` : ""}`);
    }
    for (const c of controls) {
      if (inForm.has(c.id)) continue;
      switch (c.kind) {
        case "table": {
          const t = p.tables.find((x) => x.headers.join(" | ") === c.detail);
          lines.push(`    TABLE [${c.id}] ${q(c.name)} columns: ${c.detail}${t ? `; ${t.rowCount} rows shown${t.linkHeaders.length ? `; links in ${t.linkHeaders.join(", ")} -> ${t.sampleLinks.slice(0, 1).map((l) => routePattern(new URL(l, m.origin).toString())).join("")}` : ""}` : ""}`);
          if (t && opts.samples !== false && t.sampleRows[0]) lines.push(`      sample row: ${t.sampleRows[0].map((x) => q(x)).join(" | ")}`);
          break;
        }
        case "fact":
          lines.push(`    FACT [${c.id}] ${q(c.name)}${opts.samples !== false && c.sample !== undefined ? ` sample=${q(c.sample)}` : ""}`);
          break;
        case "pagination":
          lines.push(`    PAGINATION [${c.id}] ${q(c.name)}`);
          break;
        case "tab":
          lines.push(`    TAB [${c.id}] ${q(c.name)}`);
          break;
        case "link": {
          const hp = hrefPattern(c, m.origin);
          lines.push(`    LINK [${c.id}] ${q(c.name)}${hp ? ` -> ${hp}` : ""}`);
          break;
        }
        case "button":
          lines.push(`    BUTTON [${c.id}] ${q(c.name)}${c.effectGuess ? ` effect=${c.effectGuess}` : ""}${c.inDialog ? " (in dialog)" : ""}`);
          break;
        default:
          lines.push(`    ${c.kind.toUpperCase()} [${c.id}] ${q(c.label ?? c.name)}${c.param ? ` param=${c.param}` : ""}`);
      }
    }
  }
  if (m.features.bulkOperations.length) lines.push(`  BULK OPERATIONS: ${m.features.bulkOperations.map((b) => `${b.page} (${b.description})`).join("; ")}`);
  return lines.join("\n");
}
