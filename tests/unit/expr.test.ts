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
    // '~=' folds case and surrounding whitespace on both sides (cross-app text such as emails); null never matches.
    expect(evaluate("len(filterBy($out.scan.rows, 'status', '~=', '  REFUNDED '))", scope)).toBe(evaluate("len(filterBy($out.scan.rows, 'status', '==', 'refunded'))", scope));
    const crm = { ...scope, out: { crm: { rows: [{ id: "C1", email: " Ann@X.com" }, { id: "C2", email: "bob@x.com" }, { id: "C3", email: null }] } } };
    expect(evaluate("pluck(filterBy($out.crm.rows, 'email', '~=', 'ann@x.COM '), 'id')", crm)).toEqual(["C1"]);
    expect(evaluate("pluck(filterBy($out.crm.rows, 'email', '==', 'ann@x.com'), 'id')", crm)).toEqual([]);
    expect(evaluate("len(filterBy($out.crm.rows, 'email', '~=', null))", crm)).toBe(0);
    expect(evaluate("pluck(filterBy(entries(countBy(filterBy($out.scan.rows, 'status', '==', 'refunded'), 'cust')), 'value', '>=', 2), 'key')", scope)).toEqual(["C1"]);
    expect(evaluate("lookup($out.scan.rows, 'id', 'b')", scope)).toEqual({ id: "b", status: "delivered", cust: "C1" });
    expect(evaluate("range(1, 4)", scope)).toEqual([1, 2, 3, 4]);
    expect(evaluate("len($input.records)", scope)).toBe(2);
    expect(evaluate("if($rec.qty > 5, 'big', 'small')", scope)).toBe("small");
  });

  it("does arithmetic with the usual precedence, and concatenates text with +", () => {
    const sc = { rec: { n: "4", s: "ORD" }, out: { r: { rows: [1, 2, 3] } }, input: {}, phase: {} };
    expect(evaluate("len($out.r.rows) - 1", sc)).toBe(2);
    expect(evaluate("1 + 2 * 3", sc)).toBe(7);
    expect(evaluate("(1 + 2) * 3", sc)).toBe(9);
    expect(evaluate("$rec.n / 2", sc)).toBe(2);
    expect(evaluate("1 / 0", sc)).toBeNull();
    expect(evaluate("$rec.s + '-' + 7", sc)).toBe("ORD-7");
    expect(evaluate("'a' - 1", sc)).toBeNull();
    expect(evaluateBool("len($out.r.rows) - 1 >= 2 && 2 * 2 == 4", sc)).toBe(true);
    expect(evaluate("-2 + 5", sc)).toBe(3);
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
