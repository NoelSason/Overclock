import { describe, expect, it } from "vitest";
import { countInputRecordsVerified, type RecordOutcome } from "@overclock/contracts";

/** recordsVerified counts unique input records, never the outcomes of derived (later-phase) records. */

const o = (recordKey: string, status: RecordOutcome["status"], scope?: RecordOutcome["scope"]): RecordOutcome => ({ recordKey, status, writes: status === "VERIFIED" ? 1 : 0, receipts: [], notes: [], ...(scope ? { scope } : {}) });

describe("countInputRecordsVerified", () => {
  it("excludes records derived by a later phase (10 orders plus one customer hold is 10, not 11)", () => {
    const outcomes = [...Array.from({ length: 10 }, (_, i) => o(`O-${i}`, "VERIFIED", "input")), o("C-7", "VERIFIED", "derived")];
    expect(countInputRecordsVerified(outcomes)).toBe(10);
  });

  it("counts SKIPPED input records (correctly needing no change) and nothing that failed", () => {
    expect(countInputRecordsVerified([o("a", "VERIFIED", "input"), o("b", "SKIPPED", "input"), o("c", "FAILED", "input"), o("d", "UNCONFIRMED", "input"), o("e", "NEEDS_APPROVAL", "input")])).toBe(2);
  });

  it("counts each input record once, so the share can't exceed the input", () => {
    expect(countInputRecordsVerified([o("a", "VERIFIED", "input"), o("a", "SKIPPED", "input"), o("b", "VERIFIED")])).toBe(2);
  });
});
