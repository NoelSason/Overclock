import { describe, expect, it } from "vitest";
import { applyEvent, createRunView, type RunEvent } from "@overclock/contracts";
import { ApiError, engineOrigin } from "../../apps/extension/src/api";
import { parseCsvRows, parseRecordsCsv } from "../../apps/extension/src/csv";
import { eventLine, fmtMs, outcomeLabel, recordProgress } from "../../apps/extension/src/format";
import { SseParser } from "../../apps/extension/src/sse";
import { ExtensionAccess, unpackedExtensionId } from "../../services/engine/src/extension";
import { statedRecordCount, validateRecords } from "../../services/engine/src/workflows";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("extension: SSE parsing", () => {
  it("assembles messages split across chunks and ignores heartbeats", () => {
    const p = new SseParser();
    expect(p.push("id: 1\nevent: run-event\nda")).toEqual([]);
    expect(p.push('ta: {"a":1}\n\n: ping\n\nid: 2\r\nevent: run-event\r\ndata: {"b":2}\r\n\r\n')).toEqual([
      { id: "1", event: "run-event", data: '{"a":1}' },
      { id: "2", event: "run-event", data: '{"b":2}' },
    ]);
    expect(p.push("event: end\ndata: {}\n\n")).toEqual([{ id: null, event: "end", data: "{}" }]);
  });
});

describe("extension: records from CSV", () => {
  it("parses quoted fields, embedded commas and newlines, and a BOM", () => {
    expect(parseCsvRows('﻿a,b\n"x, y","line1\nline2"\n')).toEqual([
      ["a", "b"],
      ["x, y", "line1\nline2"],
    ]);
  });

  it("accepts exactly the workflow's columns, in any order", () => {
    const r = parseRecordsCsv("orderId\nORD-1\nORD-2\n", ["orderId"]);
    expect(r.errors).toEqual([]);
    expect(r.records).toEqual([{ orderId: "ORD-1" }, { orderId: "ORD-2" }]);
  });

  it("reports missing and unexpected columns, short rows, blanks, and repeats", () => {
    expect(parseRecordsCsv("customer\nC-1\n", ["orderId"]).errors.join(" ")).toMatch(/Missing column: orderId.*Unexpected column: customer/);
    const r = parseRecordsCsv("orderId,note\nORD-1,x\nORD-2\n,y\nORD-1,x\n");
    expect(r.errors.join(" ")).toMatch(/Line 3 has 1 values/);
    expect(r.errors.join(" ")).toMatch(/Line 4 is missing orderId/);
    expect(r.errors.join(" ")).toMatch(/Line 5 repeats an earlier record/);
    expect(parseRecordsCsv("orderId\n").errors).toContain("The file has a header row but no records.");
  });
});

describe("extension: engine address", () => {
  it("accepts only this computer's loopback addresses", () => {
    expect(engineOrigin("127.0.0.1:4000")).toBe("http://127.0.0.1:4000");
    expect(engineOrigin("http://localhost:4020/x")).toBe("http://localhost:4020");
    expect(() => engineOrigin("https://example.com")).toThrow(ApiError);
    expect(() => engineOrigin("http://10.0.0.5:4000")).toThrow(/this computer/);
  });
});

describe("extension: wording comes from real events and outcomes", () => {
  const ev = (e: Record<string, unknown>, seq = 1): RunEvent => ({ seq, runId: "r", ts: 0, t: 0, ...e }) as unknown as RunEvent;

  it("describes reuse, verification, and the write canary", () => {
    expect(eventLine(ev({ type: "policy.decision", intelligence: "warm-cache", candidates: 0, reason: "", features: {} }))?.text).toMatch(/learned on this computer: no AI planning/);
    expect(eventLine(ev({ type: "policy.decision", intelligence: "network-import", candidates: 0, reason: "", features: {} }))?.text).toMatch(/team's verified workflow/);
    expect(eventLine(ev({ type: "receipt", taskId: "t", recordKey: "ORD-1", status: "VERIFIED", nodeId: "save", fields: [] }))).toEqual({ text: "ORD-1: change confirmed by re-reading the page.", tone: "ok" });
    expect(eventLine(ev({ type: "receipt", taskId: "t", recordKey: "ORD-1", status: "UNCONFIRMED", nodeId: "save", fields: [] }))?.tone).toBe("warn");
    expect(eventLine(ev({ type: "log", level: "info", message: "write canary passed for per_order.s8: one record wrote" }))?.text).toMatch(/Safety check passed/);
    expect(eventLine(ev({ type: "action", taskId: "t", nodeId: "n", actionType: "navigate", ms: 3, ok: true, modelCalls: 0 }))).toBeNull();
  });

  it("labels outcomes without claiming more than the engine did", () => {
    expect(outcomeLabel({ status: "VERIFIED", writes: 2 }).label).toBe("Changed · verified");
    expect(outcomeLabel({ status: "SKIPPED", writes: 0 }).label).toBe("No change needed");
    expect(outcomeLabel({ status: "UNCONFIRMED", writes: 0 }).tone).toBe("warn");
    expect(fmtMs(2450)).toBe("2.5 s");
  });

  it("counts input records done from the shared reducer's task states", () => {
    let v = createRunView("r");
    const task = (taskId: string, recordKey: string, state: string, seq: number) => {
      v = applyEvent(v, ev({ type: "tasks.created", tasks: [{ taskId, segmentId: taskId.split("@")[0], phaseId: "p", recordKey }] }, seq));
      v = applyEvent(v, ev({ type: "task.state", taskId, state }, seq + 1));
    };
    task("s1@ORD-1", "ORD-1", "COMPLETED", 1);
    task("s2@ORD-1", "ORD-1", "VERIFIED", 3);
    task("s1@ORD-2", "ORD-2", "RUNNING", 5);
    task("hold@C-9", "C-9", "VERIFIED", 7);
    expect(recordProgress(v, [{ orderId: "ORD-1" }, { orderId: "ORD-2" }])).toEqual({ finished: 1, total: 2 });
  });
});

describe("engine: workflow records and pairing", () => {
  it("validates records against a workflow's fields", () => {
    expect(validateRecords([{ orderId: "A" }, { orderId: 7 }], ["orderId"])).toEqual({ records: [{ orderId: "A" }, { orderId: "7" }], errors: [] });
    expect(validateRecords([{ orderId: "A", extra: "x" }, { orderId: "" }, { orderId: "A" }], ["orderId"]).errors).toEqual(['record 1 has an unexpected field "extra" (expected orderId)', 'record 2 is missing "orderId"', "record 3 repeats an earlier record"]);
    expect(validateRecords("nope", ["orderId"]).errors).toEqual(["records must be a list"]);
  });

  it("knows when instructions state the batch size", () => {
    expect(statedRecordCount("Reconcile these 10 customer orders across CRM. More rules.", 10)).toBe(10);
    expect(statedRecordCount("Reconcile these 100 customer orders.", 10)).toBeNull();
    expect(statedRecordCount("For each order, update the ticket.", 10)).toBeNull();
  });

  it("issues a token for the current code once, and replaces the code after too many wrong guesses", () => {
    let now = 0;
    const codes: string[] = [];
    const a = new ExtensionAccess({ now: () => now, maxFailures: 3, codeTtlMs: 60_000, tokenTtlMs: 1000, onCode: (c) => codes.push(c) });
    const first = a.currentCode();
    expect(first).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const s = a.pair(first.toLowerCase());
    expect(s?.token).toMatch(/^[0-9a-f]{64}$/);
    expect(a.verify(s!.token)).toBe(true);
    expect(a.pair(first)).toBeNull(); // single use
    const second = a.currentCode();
    for (let i = 0; i < 3; i++) expect(a.pair("AAAA-AAAA-AAAA")).toBeNull();
    expect(a.currentCode()).not.toBe(second);
    expect(a.pair(second)).toBeNull();
    now = 2000;
    expect(a.verify(s!.token)).toBe(false); // expired
    expect(codes.length).toBeGreaterThanOrEqual(3);
  });

  it("trusts an extension after one code pairing, and keeps tokens across restarts without storing them", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-access-"));
    const file = join(dir, "access.json");
    const ext = "abcdefghijklmnopabcdefghijklmnop";
    const a = new ExtensionAccess({ file });
    expect(a.autoPair(ext)).toBeNull();
    const s = a.pair(a.currentCode(), ext)!;
    expect(readFileSync(file, "utf8")).not.toContain(s.token);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const restarted = new ExtensionAccess({ file });
    expect(restarted.verify(s.token)).toBe(true);
    expect(restarted.autoPair(ext)?.token).toMatch(/^[0-9a-f]{64}$/);
    expect(restarted.autoPair("ponmlkjihgfedcbaponmlkjihgfedcba")).toBeNull();
    expect(new ExtensionAccess({ trusted: [ext] }).autoPair(ext)).not.toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("computes an unpacked extension's id from its folder, as Chrome and Brave do", () => {
    // Observed: Chromium gave this id to apps/extension/dist loaded unpacked from this path.
    expect(unpackedExtensionId("/Users/noelsason/Desktop/Overclock/apps/extension/dist")).toBe("gepfmmhljeoapgnhhglelcghncaenpan");
  });
});
