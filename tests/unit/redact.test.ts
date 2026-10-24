import { describe, expect, it } from "vitest";
import { redact } from "@overclock/telemetry";

describe("redaction", () => {
  it("redacts credentials but keeps token counters", () => {
    const r = redact({ inputTokens: 12, outputTokens: 3, password: "hunter2", apiKey: "x", sessionId: "s", headers: { authorization: "Bearer abcdefghijklmnop", cookie: "a=b" }, note: "key sk-ant-abcdefghijklmnopqrstuvwxyz" });
    expect(r.inputTokens).toBe(12);
    expect(r.outputTokens).toBe(3);
    expect(r.password).toBe("[REDACTED]");
    expect(r.apiKey).toBe("[REDACTED]");
    expect(r.sessionId).toBe("[REDACTED]");
    expect(r.headers.authorization).toBe("[REDACTED]");
    expect(r.headers.cookie).toBe("[REDACTED]");
    expect(r.note).not.toContain("sk-ant-abc");
  });
});
