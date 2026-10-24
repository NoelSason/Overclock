import type { ActionNode, LocatorStrategy, SemanticLocator } from "@overclock/contracts";

/**
 * Test-only helpers for hand-written IR. Product code paths never use hand-written programs;
 * these exist to exercise the executor deterministically.
 */
export function loc(...strategies: LocatorStrategy[]): SemanticLocator {
  return { strategies, confidence: 1, evidence: [] };
}

export function node(partial: Partial<ActionNode> & Pick<ActionNode, "id" | "type">): ActionNode {
  return {
    dependsOn: [],
    preconditions: [],
    postconditions: [],
    reads: [],
    writes: [],
    effect: "read",
    retryPolicy: "safe",
    timeoutMs: 8000,
    ...partial,
  };
}
