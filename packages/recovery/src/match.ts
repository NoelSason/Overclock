import type { ObservedControl, ObservedForm } from "@overclock/contracts";
import type { Observation } from "@overclock/perception";
import type { TargetDescriptor, TargetKind } from "./describe";
import { formOf, rawOf } from "./locators";
import { bestNameSim, eqi, IRREVERSIBLE, jaccard } from "./text";

/**
 * L1 deterministic matching: score every observed control that could play the failing node's
 * role and accept the best one only when it clears an absolute bar AND beats the runner-up by a
 * clear margin. Structure (same form, the form's only submit, select option values, field name
 * attribute) outweighs names, because renames change names but rarely structure.
 */

export const ACCEPT_SCORE = 0.6;
export const ACCEPT_MARGIN = 0.15;

export interface Candidate {
  control: ObservedControl;
  form?: ObservedForm | undefined;
  score: number;
  signals: string[];
  /** Hidden in an inactive tab panel: needs a pre-click on that tab. */
  inHiddenTab: boolean;
}

export interface MatchContext {
  /** remote-write / irreversible click: only submits of POST forms qualify. */
  write: boolean;
  irreversible: boolean;
}

export function compatible(kind: TargetKind, c: ObservedControl): boolean {
  const isSelect = c.tag === "select" || c.role === "combobox" || c.role === "listbox";
  const isCheck = c.role === "checkbox" || c.role === "switch";
  const isText = !isSelect && !isCheck && c.role !== "radio" && c.role !== "button" && (c.tag === "input" || c.tag === "textarea" || c.role === "textbox" || c.role === "searchbox" || c.role === "spinbutton");
  switch (kind) {
    case "button":
      return c.role === "button";
    case "link":
      return c.role === "link";
    case "tab":
      return c.role === "tab";
    case "select":
      return isSelect;
    case "checkbox":
      return isCheck;
    case "field":
      return isText;
    case "value":
      return isSelect || isCheck || isText;
    case "table":
      return false;
  }
}

function postSubmitForm(obs: Observation, c: ObservedControl): ObservedForm | undefined {
  return obs.forms.find((f) => f.method === "post" && f.submitIds.includes(c.id));
}

/** Controls that could stand in for the target, with structural filtering applied. */
export function eligible(d: TargetDescriptor, obs: Observation, ctx: MatchContext): ObservedControl[] {
  return obs.controls.filter((c) => {
    if (c.disabled) return false;
    if (c.inDialog) return false;
    if (!c.visible && !c.tabPanel) return false;
    if (!compatible(d.kind, c)) return false;
    if (d.kind === "button" && ctx.write && !postSubmitForm(obs, c)) return false;
    // A non-destructive node must never be re-pointed at a destructive control.
    if (!ctx.irreversible && (d.kind === "button" || d.kind === "link") && IRREVERSIBLE.test(c.name) && !d.names.some((n) => IRREVERSIBLE.test(n))) return false;
    return true;
  });
}

export function rankCandidates(d: TargetDescriptor, obs: Observation, ctx: MatchContext): Candidate[] {
  const pool = eligible(d, obs, ctx);
  const postSubmits = d.kind === "button" && ctx.write ? pool : [];
  const sameKindInPage = pool.length;
  const scoped = d.scopeCss ? obs.forms.find((f) => f.cssPath === d.scopeCss) : undefined;
  const out: Candidate[] = [];
  for (const c of pool) {
    const raw = rawOf(obs, c);
    const form = formOf(obs, c);
    const signals: string[] = [];
    let score = 0;
    const ns = bestNameSim(d.names, [c.label, c.name, c.placeholder]);
    if (ns > 0) {
      score += 0.45 * ns;
      signals.push(`name ${ns.toFixed(2)}`);
    }
    if (d.testId && c.testId === d.testId) {
      score += 0.5;
      signals.push("test id");
    }
    if (d.cssId && c.cssPath === `#${d.cssId}`) {
      score += 0.45;
      signals.push("element id");
    }
    if (d.param && raw?.param === d.param) {
      score += 0.35;
      signals.push(`field name "${d.param}"`);
    }
    if (d.inputType && c.type === d.inputType) score += 0.05;
    if (d.kind === "select") {
      const opts = c.options ?? [];
      if (d.desired !== undefined && d.desired !== "") {
        if (opts.some((o) => eqi(o.value, d.desired) || eqi(o.label, d.desired))) {
          score += 0.25;
          signals.push(`offers "${d.desired}"`);
        } else {
          score -= 0.4;
          signals.push(`lacks "${d.desired}"`);
        }
      }
      if (d.options?.length) {
        const j = jaccard(d.options, opts.map((o) => o.value));
        score += 0.25 * j;
        if (j > 0) signals.push(`options ${j.toFixed(2)}`);
      }
    }
    if (scoped && form?.id === scoped.id) {
      score += 0.3;
      signals.push("same form");
    }
    if (d.kind === "button" && ctx.write) {
      if (postSubmits.length === 1) {
        score += 0.65;
        signals.push("only submit of a POST form");
      } else if (scoped && form?.id === scoped.id && scoped.submitIds.length === 1) {
        score += 0.45;
        signals.push("only submit of the same form");
      }
    } else if (sameKindInPage === 1 && d.kind !== "button" && d.kind !== "link") {
      score += 0.25;
      signals.push(`only ${d.kind} on the page`);
    }
    out.push({ control: c, form, score: Math.max(0, Math.min(1, score)), signals, inHiddenTab: !c.visible && !!c.tabPanel });
  }
  return out.sort((a, b) => b.score - a.score);
}

export interface Decision {
  pick?: Candidate | undefined;
  /** Plausible candidates when no clear winner exists (for the model tiers). */
  shortlist: Candidate[];
  reason: string;
}

export function decide(ranked: Candidate[]): Decision {
  const [best, second] = ranked;
  if (!best) return { shortlist: [], reason: "no compatible control on the page" };
  const margin = best.score - (second?.score ?? 0);
  const shortlist = ranked.filter((c) => c.score >= Math.max(0.05, best.score - 0.35)).slice(0, 6);
  if (best.score >= ACCEPT_SCORE && margin >= ACCEPT_MARGIN) return { pick: best, shortlist, reason: `${best.control.id} ${JSON.stringify(best.control.label ?? best.control.name)} score ${best.score.toFixed(2)} (${best.signals.join(", ")}), margin ${margin.toFixed(2)}` };
  if (best.score < ACCEPT_SCORE) return { shortlist, reason: `best match ${JSON.stringify(best.control.label ?? best.control.name)} scores only ${best.score.toFixed(2)}` };
  return { shortlist, reason: `ambiguous: ${shortlist.map((c) => `${JSON.stringify(c.control.label ?? c.control.name)} ${c.score.toFixed(2)}`).join(" vs ")}` };
}

/** Facts (label/value pairs) that could stand in for an extract field. */
export function rankFacts(d: TargetDescriptor, obs: Observation): { idx: number; label: string; score: number }[] {
  return obs.facts
    .map((f, idx) => {
      const label = f.label.includes(" › ") ? f.label.split(" › ").pop()! : f.label;
      return { idx, label: f.label, score: 0.9 * bestNameSim(d.names, [label, f.label]) };
    })
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score);
}
