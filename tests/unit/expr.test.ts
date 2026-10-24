import { describe, expect, it } from "vitest";
import { evaluate, evaluateBool, ExprError, parseExpr, renderTemplate, templateExprs } from "@overclock/compiler";

const scope = {
  rec: { orderId: "ORD-1001", qty: "3" },
  out: { find: { status: "Refunded", ticketId: "T-9" }, scan: { rows: [{ id: "a", status: "refunded", cust: "C1" }, { id: "b", status: "delivered", cust: "C1" }, { id: "c", status: "refunded", cust: "C1" }, { id: "d", status: "refunded", cust: "C2" }] } },
  input: { records: [{ orderId: "ORD-1" }, { orderId: "ORD-2" }] },
  phase: {},
};

describe("expression language", () => {
  it("evaluates paths, comparisons and boolean logic", () => {
    expect(evaluate("$rec.orderId", scope)).toBe("ORD-1001");
    expect(evaluateBool("lower($out.find.status) == 'refunded' && $rec.qty > 2", scope)).toBe(true);
    expect(evaluateBool("$rec.qty == 3", scope)).toBe(true); // numeric string coerces
    expect(evaluateBool("!($out.find.status in ['Open', 'Pending'])", scope)).toBe(true);
    expect(evaluate("$out.missing.deep.path", scope)).toBeNull();
  });

  it("supports aggregation helpers used for cross-record dependencies", () => {
    expect(evaluate("countBy(filterBy($out.scan.rows, 'status', '==', 'refunded'), 'cust')", scope)).toEqual({ C1: 2, C2: 1 });
    expect(evaluate("pluck(filterBy(entries(countBy(filterBy($out.scan.rows, 'status', '==', 'refunded'), 'cust')), 'value', '>=', 2), 'key')", scope)).toEqual(["C1"]);
    expect(evaluate("lookup($out.scan.rows, 'id', 'b')", scope)).toEqual({ id: "b", status: "delivered", cust: "C1" });
    expect(evaluate("range(1, 4)", scope)).toEqual([1, 2, 3, 4]);
    expect(evaluate("len($input.records)", scope)).toBe(2);
    expect(evaluate("if($rec.qty > 5, 'big', 'small')", scope)).toBe("small");
  });

  it("renders templates", () => {
    expect(renderTemplate("/orders/{$rec.orderId}?q={lower('A B')}", scope)).toBe("/orders/ORD-1001?q=a b");
    expect(templateExprs("/t/{$out.find.ticketId}/edit")).toEqual(["$out.find.ticketId"]);
  });

  it("records static references for dependency inference", () => {
    const p = parseExpr("$out.find.status == 'x' || len($phase.read_orders) > 0");
    expect([...p.outRefs]).toEqual(["find"]);
    expect([...p.phaseRefs]).toEqual(["read_orders"]);
  });

  it("rejects anything outside the closed language", () => {
    expect(() => parseExpr("process.exit(1)")).toThrow(ExprError);
    expect(() => parseExpr("eval('1')")).toThrow(/Unknown function/);
    expect(() => parseExpr("constructor('x')")).toThrow(/Unknown function/);
    expect(() => parseExpr("lower()")).toThrow(/arguments/);
    expect(() => parseExpr("$rec.a = 1")).toThrow(ExprError);
    expect(evaluate("$rec.constructor", scope)).toBeNull();
    expect(evaluate("$rec.__proto__", scope)).toBeNull();
  });

  it("bounds evaluation", () => {
    expect(() => evaluate("range(1, 100000)", scope)).toThrow(/range too large/);
  });
});
