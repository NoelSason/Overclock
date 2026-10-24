import type { SemanticLocator } from "@overclock/contracts";
import { normalize } from "./text";

/**
 * L0: deterministic rules learned from earlier repairs in this run. Applying one takes no
 * observation and no model call. Rules are keyed by app, route pattern, and the failing control
 * (or dialog title), so they also cover other segment templates that use the same control.
 */

export interface LocatorRule {
  kind: "locator";
  id: string;
  key: string;
  locator?: SemanticLocator | undefined;
  prelude?: SemanticLocator[] | undefined;
  learnedAt: number;
  hits: number;
  detail: string;
}

export interface DialogRule {
  kind: "dialog";
  id: string;
  key: string;
  title: string;
  button: SemanticLocator;
  confirmsWrite: boolean;
  learnedAt: number;
  hits: number;
  detail: string;
}

export type Rule = LocatorRule | DialogRule;

export type FailureKind = "relocate" | "hidden" | "dialog";

export function locatorRuleKey(app: string, route: string, kind: "relocate" | "hidden", target: string): string {
  return `loc|${app}|${route}|${kind}|${target}`;
}

export function dialogRuleKey(app: string, route: string, afterWrite: boolean): string {
  return `dlg|${app}|${route}|${afterWrite ? "after-write" : "blocking"}`;
}

export class RuleBook {
  private readonly locators = new Map<string, LocatorRule>();
  private readonly dialogs = new Map<string, DialogRule[]>();
  private readonly byId = new Map<string, Rule>();
  private seq = 0;

  get size(): number {
    return this.byId.size;
  }

  all(): Rule[] {
    return [...this.byId.values()];
  }

  get(id: string): Rule | undefined {
    return this.byId.get(id);
  }

  learnLocator(key: string, r: { locator?: SemanticLocator | undefined; prelude?: SemanticLocator[] | undefined; detail: string }): LocatorRule {
    const old = this.locators.get(key);
    if (old) this.byId.delete(old.id);
    const rule: LocatorRule = { kind: "locator", id: `r${++this.seq}`, key, locator: r.locator, prelude: r.prelude, learnedAt: Date.now(), hits: 0, detail: r.detail };
    this.locators.set(key, rule);
    this.byId.set(rule.id, rule);
    return rule;
  }

  learnDialog(key: string, r: { title: string; button: SemanticLocator; confirmsWrite: boolean; detail: string }): DialogRule {
    const list = (this.dialogs.get(key) ?? []).filter((d) => {
      const same = normalize(d.title) === normalize(r.title);
      if (same) this.byId.delete(d.id);
      return !same;
    });
    const rule: DialogRule = { kind: "dialog", id: `r${++this.seq}`, key, title: r.title, button: r.button, confirmsWrite: r.confirmsWrite, learnedAt: Date.now(), hits: 0, detail: r.detail };
    list.push(rule);
    this.dialogs.set(key, list);
    this.byId.set(rule.id, rule);
    return rule;
  }

  locator(key: string): LocatorRule | undefined {
    return this.locators.get(key);
  }

  /** A learned dialog rule whose title the open dialog's text starts with. */
  dialog(key: string, dialogText: string): DialogRule | undefined {
    const text = normalize(dialogText);
    return (this.dialogs.get(key) ?? []).find((d) => d.title && text.startsWith(normalize(d.title)));
  }

  forget(id: string): void {
    const r = this.byId.get(id);
    if (!r) return;
    this.byId.delete(id);
    if (r.kind === "locator") {
      if (this.locators.get(r.key)?.id === id) this.locators.delete(r.key);
    } else {
      this.dialogs.set(
        r.key,
        (this.dialogs.get(r.key) ?? []).filter((d) => d.id !== id),
      );
    }
  }
}
