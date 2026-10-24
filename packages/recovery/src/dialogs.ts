import type { ObservedControl, ObservedDialog } from "@overclock/contracts";
import type { Observation } from "@overclock/perception";
import { IRREVERSIBLE, normalize } from "./text";

/**
 * Dialog classification for L1. A dialog that appeared right after a write click and offers one
 * confirm-like control is a confirmation: confirming completes the write. Any other dialog is
 * interference: dismiss it. Nothing irreversible is ever confirmed.
 */

export type ButtonClass = "irreversible" | "confirm" | "dismiss" | "cancel" | "other";

const CONFIRM = /^(confirm|yes|save|continue|ok|okay|apply|submit|update|proceed|done|accept changes)\b/i;
const DISMISS = /^(dismiss|close|got it|no thanks|not now|skip|maybe later|later|×|✕|✖|x|ok|okay|understood)$/i;
const CANCEL = /^(cancel|no|back|go back|keep editing)$/i;

export function classifyButton(name: string, afterWrite: boolean): ButtonClass {
  const n = name.trim();
  if (IRREVERSIBLE.test(n)) return "irreversible";
  // "OK" confirms a pending write but merely acknowledges an informational dialog.
  if (afterWrite && CONFIRM.test(n)) return "confirm";
  if (DISMISS.test(n)) return "dismiss";
  if (CANCEL.test(n)) return "cancel";
  if (CONFIRM.test(n)) return "confirm";
  return "other";
}

/** The submit itself raised the dialog (vs a dialog that was blocking the page beforehand). */
export function raisedByWrite(message: string): boolean {
  return /^Submit was intercepted/i.test(message);
}

export function openDialogs(obs: Observation): ObservedDialog[] {
  return obs.dialogs.filter((d) => d.open);
}

/** The open dialog the error refers to: the one whose text the error captured, else the last open one. */
export function matchDialog(obs: Observation, dialogText: string): ObservedDialog | undefined {
  const open = openDialogs(obs);
  const want = normalize(dialogText).slice(0, 60);
  return open.find((d) => want && (normalize(d.text).startsWith(want.slice(0, 30)) || want.startsWith(normalize(d.title)))) ?? open[open.length - 1];
}

export function dialogButtons(obs: Observation, d: ObservedDialog): ObservedControl[] {
  return d.controlIds.map((id) => obs.controls.find((c) => c.id === id)).filter((c): c is ObservedControl => !!c && c.role === "button" && !c.disabled);
}

export function dialogHasInputs(obs: Observation, d: ObservedDialog): boolean {
  return d.controlIds.some((id) => {
    const c = obs.controls.find((x) => x.id === id);
    return !!c && c.role !== "button" && c.role !== "link";
  });
}

export type DialogDecision =
  | { action: "confirm"; button: ObservedControl; reason: string }
  | { action: "dismiss"; button: ObservedControl; reason: string }
  | { action: "ambiguous"; candidates: ObservedControl[]; reason: string }
  | { action: "escalate"; reason: string };

export function decideDialog(args: { obs: Observation; dialog: ObservedDialog; afterWrite: boolean; nodeIsWrite: boolean; nodeIrreversible: boolean }): DialogDecision {
  const { obs, dialog, afterWrite } = args;
  const buttons = dialogButtons(obs, dialog);
  const classes = buttons.map((b) => ({ b, cls: classifyButton(b.name, afterWrite && args.nodeIsWrite) }));
  const title = dialog.title || dialog.text.slice(0, 40);
  if (afterWrite && args.nodeIsWrite) {
    if (args.nodeIrreversible) return { action: "escalate", reason: `"${title}" asks to confirm an irreversible action; a person must confirm it` };
    if (IRREVERSIBLE.test(dialog.title) || IRREVERSIBLE.test(dialog.text)) return { action: "escalate", reason: `"${title}" describes an irreversible action (${(IRREVERSIBLE.exec(dialog.title + " " + dialog.text) ?? [""])[0]}); not confirming it` };
    const confirms = classes.filter((x) => x.cls === "confirm").map((x) => x.b);
    if (confirms.length === 1) return { action: "confirm", button: confirms[0]!, reason: `"${title}" is a confirmation of the submitted edit; confirming with "${confirms[0]!.name}"` };
    if (!confirms.length) {
      const destructive = classes.filter((x) => x.cls === "irreversible").map((x) => x.b.name);
      if (destructive.length) return { action: "escalate", reason: `"${title}" only offers ${destructive.map((n) => `"${n}"`).join(", ")}, which cannot be undone` };
      const others = classes.filter((x) => x.cls === "other").map((x) => x.b);
      if (others.length) return { action: "ambiguous", candidates: others, reason: `"${title}" has no recognizable confirm button (${others.map((b) => `"${b.name}"`).join(", ")})` };
      return { action: "escalate", reason: `"${title}" offers no way to confirm the edit` };
    }
    return { action: "ambiguous", candidates: confirms, reason: `"${title}" offers several confirm-like buttons (${confirms.map((b) => `"${b.name}"`).join(", ")})` };
  }
  const dismiss = classes.filter((x) => x.cls === "dismiss").map((x) => x.b);
  if (dismiss.length === 1) return { action: "dismiss", button: dismiss[0]!, reason: `"${title}" is informational; dismissing with "${dismiss[0]!.name}"` };
  const cancel = classes.filter((x) => x.cls === "cancel").map((x) => x.b);
  if (!dismiss.length && cancel.length === 1) return { action: "dismiss", button: cancel[0]!, reason: `"${title}" is blocking the page; closing it with "${cancel[0]!.name}"` };
  if (dialogHasInputs(obs, dialog)) return { action: "escalate", reason: `"${title}" asks for input; a person must answer it` };
  const safe = classes.filter((x) => x.cls === "dismiss" || x.cls === "cancel" || x.cls === "other").map((x) => x.b);
  if (safe.length) return { action: "ambiguous", candidates: safe, reason: `"${title}" has no single clear way to close it (${safe.map((b) => `"${b.name}"`).join(", ")})` };
  return { action: "escalate", reason: `"${title}" offers no safe way to close it` };
}
