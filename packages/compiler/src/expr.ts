/**
 * Overclock expression language: a small, closed, side-effect-free language for values,
 * guards, and conditions in compiled programs. Model-generated plans may only use this
 * language; nothing a model writes is ever evaluated as JavaScript.
 *
 *   expr   := or
 *   or     := and ('||' and)*
 *   and    := eq ('&&' eq)*
 *   eq     := cmp (('==' | '!=') cmp)*
 *   cmp    := member (('<' | '<=' | '>' | '>=' | 'in') member)*
 *   member := unary
 *   unary  := ('!' | '-') unary | postfix
 *   postfix:= primary ('.' ident | '[' expr ']')*
 *   primary:= number | string | true | false | null | $root | ident '(' args ')' | '(' expr ')' | '[' items ']'
 */

export type Ast =
  | { k: "lit"; v: string | number | boolean | null }
  | { k: "root"; name: string }
  | { k: "member"; obj: Ast; prop: string }
  | { k: "index"; obj: Ast; index: Ast }
  | { k: "call"; fn: string; args: Ast[] }
  | { k: "unary"; op: "!" | "-"; arg: Ast }
  | { k: "binary"; op: BinaryOp; left: Ast; right: Ast }
  | { k: "list"; items: Ast[] };

type BinaryOp = "||" | "&&" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "+" | "-" | "*" | "/";

export class ExprError extends Error {
  constructor(
    message: string,
    readonly source: string,
    readonly pos?: number,
  ) {
    super(pos === undefined ? `${message} in \`${source}\`` : `${message} at ${pos} in \`${source}\``);
  }
}

type Tok = { t: "num"; v: number; p: number } | { t: "str"; v: string; p: number } | { t: "id"; v: string; p: number } | { t: "root"; v: string; p: number } | { t: "op"; v: string; p: number } | { t: "eof"; p: number };

const OPS = ["==", "!=", "<=", ">=", "&&", "||", "<", ">", "!", "-", "+", "*", "/", "(", ")", "[", "]", ",", "."];

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      toks.push({ t: "num", v: Number(m[0]), p: i });
      i += m[0].length;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          out += src[j + 1];
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new ExprError("Unterminated string", src, i);
      toks.push({ t: "str", v: out, p: i });
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      if (!m) throw new ExprError("Invalid $root", src, i);
      toks.push({ t: "root", v: m[0].slice(1), p: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      toks.push({ t: "id", v: m[0], p: i });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`Unexpected character '${c}'`, src, i);
    toks.push({ t: "op", v: op, p: i });
    i += op.length;
  }
  toks.push({ t: "eof", p: src.length });
  return toks;
}

class Parser {
  private i = 0;
  constructor(
    private readonly toks: Tok[],
    private readonly src: string,
  ) {}

  private peek(): Tok {
    return this.toks[this.i]!;
  }
  private next(): Tok {
    return this.toks[this.i++]!;
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return t.t === "op" && t.v === v;
  }
  private isId(v: string): boolean {
    const t = this.peek();
    return t.t === "id" && t.v === v;
  }
  private expectOp(v: string): void {
    const t = this.next();
    if (t.t !== "op" || t.v !== v) throw new ExprError(`Expected '${v}'`, this.src, t.p);
  }

  parse(): Ast {
    const e = this.or();
    if (this.peek().t !== "eof") throw new ExprError("Unexpected trailing input", this.src, this.peek().p);
    return e;
  }
  private or(): Ast {
    let l = this.and();
    while (this.isOp("||")) {
      this.next();
      l = { k: "binary", op: "||", left: l, right: this.and() };
    }
    return l;
  }
  private and(): Ast {
    let l = this.eq();
    while (this.isOp("&&")) {
      this.next();
      l = { k: "binary", op: "&&", left: l, right: this.eq() };
    }
    return l;
  }
  private eq(): Ast {
    let l = this.cmp();
    while (this.isOp("==") || this.isOp("!=")) {
      const op = (this.next() as { v: string }).v as BinaryOp;
      l = { k: "binary", op, left: l, right: this.cmp() };
    }
    return l;
  }
  private cmp(): Ast {
    let l = this.additive();
    for (;;) {
      if (this.isOp("<") || this.isOp("<=") || this.isOp(">") || this.isOp(">=")) {
        const op = (this.next() as { v: string }).v as BinaryOp;
        l = { k: "binary", op, left: l, right: this.additive() };
      } else if (this.isId("in")) {
        this.next();
        l = { k: "binary", op: "in", left: l, right: this.additive() };
      } else return l;
    }
  }
  private additive(): Ast {
    let l = this.multiplicative();
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.next() as { v: string }).v as BinaryOp;
      l = { k: "binary", op, left: l, right: this.multiplicative() };
    }
    return l;
  }
  private multiplicative(): Ast {
    let l = this.unary();
    while (this.isOp("*") || this.isOp("/")) {
      const op = (this.next() as { v: string }).v as BinaryOp;
      l = { k: "binary", op, left: l, right: this.unary() };
    }
    return l;
  }
  private unary(): Ast {
    if (this.isOp("!")) {
      this.next();
      return { k: "unary", op: "!", arg: this.unary() };
    }
    if (this.isOp("-")) {
      this.next();
      return { k: "unary", op: "-", arg: this.unary() };
    }
    return this.postfix();
  }
  private postfix(): Ast {
    let e = this.primary();
    for (;;) {
      if (this.isOp(".")) {
        this.next();
        const t = this.next();
        if (t.t !== "id") throw new ExprError("Expected property name", this.src, t.p);
        e = { k: "member", obj: e, prop: t.v };
      } else if (this.isOp("[")) {
        this.next();
        const index = this.or();
        this.expectOp("]");
        e = { k: "index", obj: e, index };
      } else return e;
    }
  }
  private primary(): Ast {
    const t = this.next();
    switch (t.t) {
      case "num":
        return { k: "lit", v: t.v };
      case "str":
        return { k: "lit", v: t.v };
      case "root":
        return { k: "root", name: t.v };
      case "id": {
        if (t.v === "true") return { k: "lit", v: true };
        if (t.v === "false") return { k: "lit", v: false };
        if (t.v === "null") return { k: "lit", v: null };
        if (!this.isOp("(")) throw new ExprError(`Unknown identifier '${t.v}' (paths start with $)`, this.src, t.p);
        this.next();
        const args: Ast[] = [];
        if (!this.isOp(")")) {
          args.push(this.or());
          while (this.isOp(",")) {
            this.next();
            args.push(this.or());
          }
        }
        this.expectOp(")");
        return { k: "call", fn: t.v, args };
      }
      case "op":
        if (t.v === "(") {
          const e = this.or();
          this.expectOp(")");
          return e;
        }
        if (t.v === "[") {
          const items: Ast[] = [];
          if (!this.isOp("]")) {
            items.push(this.or());
            while (this.isOp(",")) {
              this.next();
              items.push(this.or());
            }
          }
          this.expectOp("]");
          return { k: "list", items };
        }
        throw new ExprError(`Unexpected '${t.v}'`, this.src, t.p);
      case "eof":
        throw new ExprError("Unexpected end of expression", this.src, t.p);
    }
  }
}

const MAX_LIST = 10_000;
const MAX_STEPS = 200_000;

type Fn = { min: number; max: number; impl: (args: unknown[], ctx: EvalCtx) => unknown };

interface EvalCtx {
  steps: number;
  src: string;
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return null;
    if (typeof cur !== "object" || !Object.hasOwn(cur, part)) return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur === undefined ? null : cur;
}

export function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (typeof a === "number" && typeof b === "string" && b.trim() !== "" && !Number.isNaN(Number(b))) return a === Number(b);
  if (typeof b === "number" && typeof a === "string" && a.trim() !== "" && !Number.isNaN(Number(a))) return b === Number(a);
  if (typeof a === "boolean" && typeof b === "string") return String(a) === b.toLowerCase();
  if (typeof b === "boolean" && typeof a === "string") return String(b) === a.toLowerCase();
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => looseEquals(x, b[i]));
  return false;
}

function asList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined) return [];
  return [v];
}
function asStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}
function asNum(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/[$,]/g, ""));
    return Number.isNaN(n) ? null : n;
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
}
function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v === "") return false;
  return Boolean(v);
}
function compare(op: "<" | "<=" | ">" | ">=", a: unknown, b: unknown): boolean {
  const na = asNum(a);
  const nb = asNum(b);
  if (na !== null && nb !== null) {
    return op === "<" ? na < nb : op === "<=" ? na <= nb : op === ">" ? na > nb : na >= nb;
  }
  const sa = asStr(a);
  const sb = asStr(b);
  return op === "<" ? sa < sb : op === "<=" ? sa <= sb : op === ">" ? sa > sb : sa >= sb;
}
function guardList(list: unknown[], ctx: EvalCtx): unknown[] {
  ctx.steps += list.length;
  if (list.length > MAX_LIST) throw new ExprError(`List exceeds ${MAX_LIST} items`, ctx.src);
  return list;
}

/** filterBy operators. "~=" is text equality ignoring case and surrounding whitespace on both sides. */
const FILTER_OPS = new Set(["==", "!=", "~=", "<", "<=", ">", ">=", "in", "contains"]);
const foldText = (x: unknown) => asStr(x).trim().toLowerCase();

export const FUNCTIONS: Record<string, Fn> = {
  lower: { min: 1, max: 1, impl: ([s]) => asStr(s).toLowerCase() },
  upper: { min: 1, max: 1, impl: ([s]) => asStr(s).toUpperCase() },
  trim: { min: 1, max: 1, impl: ([s]) => asStr(s).trim() },
  len: { min: 1, max: 1, impl: ([x]) => (Array.isArray(x) ? x.length : typeof x === "string" ? x.length : x && typeof x === "object" ? Object.keys(x).length : 0) },
  contains: {
    min: 2,
    max: 2,
    impl: ([hay, needle]) => (Array.isArray(hay) ? hay.some((h) => looseEquals(h, needle)) : asStr(hay).includes(asStr(needle))),
  },
  startsWith: { min: 2, max: 2, impl: ([s, p]) => asStr(s).startsWith(asStr(p)) },
  endsWith: { min: 2, max: 2, impl: ([s, p]) => asStr(s).endsWith(asStr(p)) },
  equalsIgnoreCase: { min: 2, max: 2, impl: ([a, b]) => asStr(a).trim().toLowerCase() === asStr(b).trim().toLowerCase() },
  concat: { min: 1, max: 20, impl: (args) => args.map(asStr).join("") },
  encode: { min: 1, max: 1, impl: ([s]) => encodeURIComponent(asStr(s)) },
  join: { min: 1, max: 2, impl: ([l, sep], ctx) => guardList(asList(l), ctx).map(asStr).join(sep === undefined ? "," : asStr(sep)) },
  split: { min: 2, max: 2, impl: ([s, sep]) => asStr(s).split(asStr(sep)).map((x) => x.trim()) },
  replace: { min: 3, max: 3, impl: ([s, a, b]) => asStr(s).split(asStr(a)).join(asStr(b)) },
  coalesce: { min: 1, max: 10, impl: (args) => args.find((a) => a !== null && a !== undefined && a !== "") ?? null },
  if: { min: 3, max: 3, impl: ([c, a, b]) => (truthy(c) ? a : b) },
  get: { min: 2, max: 2, impl: ([obj, key]) => getPath(obj, asStr(key)) },
  at: { min: 2, max: 2, impl: ([l, i]) => asList(l)[asNum(i) ?? -1] ?? null },
  first: { min: 1, max: 1, impl: ([l]) => asList(l)[0] ?? null },
  last: { min: 1, max: 1, impl: ([l]) => asList(l).at(-1) ?? null },
  lookup: {
    min: 3,
    max: 3,
    impl: ([l, field, value], ctx) => guardList(asList(l), ctx).find((item) => looseEquals(getPath(item, asStr(field)), value)) ?? null,
  },
  pluck: { min: 2, max: 2, impl: ([l, field], ctx) => guardList(asList(l), ctx).map((item) => getPath(item, asStr(field))) },
  filterBy: {
    min: 4,
    max: 4,
    impl: ([l, field, op, value], ctx) => {
      const o = asStr(op);
      if (!FILTER_OPS.has(o)) throw new ExprError(`filterBy: unsupported operator '${o}'`, ctx.src);
      return guardList(asList(l), ctx).filter((item) => {
        const v = getPath(item, asStr(field));
        switch (o) {
          case "==":
            return looseEquals(v, value);
          case "!=":
            return !looseEquals(v, value);
          case "~=":
            return v !== null && v !== undefined && value !== null && value !== undefined && foldText(v) === foldText(value);
          case "in":
            return asList(value).some((x) => looseEquals(v, x));
          case "contains":
            return Array.isArray(v) ? v.some((x) => looseEquals(x, value)) : asStr(v).includes(asStr(value));
          default:
            return compare(o as "<", v, value);
        }
      });
    },
  },
  countBy: {
    min: 2,
    max: 2,
    impl: ([l, field], ctx) => {
      const out: Record<string, number> = {};
      for (const item of guardList(asList(l), ctx)) {
        const k = asStr(getPath(item, asStr(field)));
        out[k] = (out[k] ?? 0) + 1;
      }
      return out;
    },
  },
  entries: { min: 1, max: 1, impl: ([o]) => (o && typeof o === "object" && !Array.isArray(o) ? Object.entries(o).map(([key, value]) => ({ key, value })) : []) },
  keys: { min: 1, max: 1, impl: ([o]) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o) : []) },
  unique: {
    min: 1,
    max: 1,
    impl: ([l], ctx) => {
      const out: unknown[] = [];
      for (const x of guardList(asList(l), ctx)) if (!out.some((y) => looseEquals(x, y))) out.push(x);
      return out;
    },
  },
  range: {
    min: 2,
    max: 2,
    impl: ([a, b], ctx) => {
      const lo = asNum(a) ?? 0;
      const hi = asNum(b) ?? -1;
      if (hi - lo + 1 > MAX_LIST) throw new ExprError("range too large", ctx.src);
      const out: number[] = [];
      for (let i = lo; i <= hi; i++) out.push(i);
      return out;
    },
  },
  sum: { min: 1, max: 1, impl: ([l], ctx) => guardList(asList(l), ctx).reduce<number>((s, x) => s + (asNum(x) ?? 0), 0) },
  min: { min: 1, max: 1, impl: ([l], ctx) => Math.min(...guardList(asList(l), ctx).map((x) => asNum(x) ?? Infinity)) },
  max: { min: 1, max: 1, impl: ([l], ctx) => Math.max(...guardList(asList(l), ctx).map((x) => asNum(x) ?? -Infinity)) },
  any: { min: 1, max: 1, impl: ([l], ctx) => guardList(asList(l), ctx).some(truthy) },
  all: { min: 1, max: 1, impl: ([l], ctx) => guardList(asList(l), ctx).every(truthy) },
  toNumber: { min: 1, max: 1, impl: ([x]) => asNum(x) },
  toString: { min: 1, max: 1, impl: (args: unknown[]) => asStr(args[0]) },
  round: { min: 1, max: 1, impl: ([x]) => Math.round(asNum(x) ?? 0) },
  isEmpty: { min: 1, max: 1, impl: ([x]) => !truthy(x) },
};

export interface ParsedExpr {
  source: string;
  ast: Ast;
  /** Root names referenced ($rec, $out, ...). */
  roots: Set<string>;
  /** Static `$out.<stepId>` references (for dependency inference). */
  outRefs: Set<string>;
  /** Static `$phase.<phaseId>` references. */
  phaseRefs: Set<string>;
}

const parseCache = new Map<string, ParsedExpr>();

export function parseExpr(source: string): ParsedExpr {
  const cached = parseCache.get(source);
  if (cached) return cached;
  const ast = new Parser(tokenize(source), source).parse();
  const roots = new Set<string>();
  const outRefs = new Set<string>();
  const phaseRefs = new Set<string>();
  const visit = (a: Ast): void => {
    switch (a.k) {
      case "root":
        roots.add(a.name);
        break;
      case "member":
        if (a.obj.k === "root" && a.obj.name === "out") outRefs.add(a.prop);
        if (a.obj.k === "root" && a.obj.name === "phase") phaseRefs.add(a.prop);
        visit(a.obj);
        break;
      case "index":
        visit(a.obj);
        visit(a.index);
        break;
      case "call": {
        const fn = Object.hasOwn(FUNCTIONS, a.fn) ? FUNCTIONS[a.fn] : undefined;
        if (!fn) throw new ExprError(`Unknown function '${a.fn}'`, source);
        if (a.args.length < fn.min || a.args.length > fn.max) throw new ExprError(`Function '${a.fn}' takes ${fn.min}-${fn.max} arguments, got ${a.args.length}`, source);
        a.args.forEach(visit);
        break;
      }
      case "unary":
        visit(a.arg);
        break;
      case "binary":
        visit(a.left);
        visit(a.right);
        break;
      case "list":
        a.items.forEach(visit);
        break;
      case "lit":
        break;
    }
  };
  visit(ast);
  const parsed = { source, ast, roots, outRefs, phaseRefs };
  if (parseCache.size > 5000) parseCache.clear();
  parseCache.set(source, parsed);
  return parsed;
}

export type Scope = Record<string, unknown>;

function evalAst(a: Ast, scope: Scope, ctx: EvalCtx): unknown {
  if (++ctx.steps > MAX_STEPS) throw new ExprError("Evaluation step budget exceeded", ctx.src);
  switch (a.k) {
    case "lit":
      return a.v;
    case "root":
      return Object.hasOwn(scope, a.name) ? (scope[a.name] ?? null) : null;
    case "member": {
      const o = evalAst(a.obj, scope, ctx);
      if (o === null || o === undefined || typeof o !== "object") return null;
      if (a.prop === "length" && Array.isArray(o)) return o.length;
      return Object.hasOwn(o, a.prop) ? ((o as Record<string, unknown>)[a.prop] ?? null) : null;
    }
    case "index": {
      const o = evalAst(a.obj, scope, ctx);
      const i = evalAst(a.index, scope, ctx);
      if (Array.isArray(o)) return o[asNum(i) ?? -1] ?? null;
      if (o && typeof o === "object") return Object.hasOwn(o, asStr(i)) ? ((o as Record<string, unknown>)[asStr(i)] ?? null) : null;
      return null;
    }
    case "call": {
      const fn = Object.hasOwn(FUNCTIONS, a.fn) ? FUNCTIONS[a.fn] : undefined;
      if (!fn) throw new ExprError(`Unknown function '${a.fn}'`, ctx.src);
      // `if` is lazy in its branches
      if (a.fn === "if") return truthy(evalAst(a.args[0]!, scope, ctx)) ? evalAst(a.args[1]!, scope, ctx) : evalAst(a.args[2]!, scope, ctx);
      return fn.impl(
        a.args.map((x) => evalAst(x, scope, ctx)),
        ctx,
      );
    }
    case "unary": {
      const v = evalAst(a.arg, scope, ctx);
      return a.op === "!" ? !truthy(v) : -(asNum(v) ?? 0);
    }
    case "binary": {
      if (a.op === "&&") return truthy(evalAst(a.left, scope, ctx)) && truthy(evalAst(a.right, scope, ctx));
      if (a.op === "||") {
        const l = evalAst(a.left, scope, ctx);
        return truthy(l) ? l : evalAst(a.right, scope, ctx);
      }
      const l = evalAst(a.left, scope, ctx);
      const r = evalAst(a.right, scope, ctx);
      switch (a.op) {
        case "==":
          return looseEquals(l, r);
        case "!=":
          return !looseEquals(l, r);
        case "in":
          return Array.isArray(r) ? r.some((x) => looseEquals(l, x)) : r && typeof r === "object" ? asStr(l) in r : asStr(r).includes(asStr(l));
        case "+":
        case "-":
        case "*":
        case "/": {
          // Numbers only; "+" with a non-number is text concatenation (null counts as "").
          const x = asNum(l);
          const y = asNum(r);
          if (x === null || y === null) return a.op === "+" ? asStr(l) + asStr(r) : null;
          if (a.op === "/") return y === 0 ? null : x / y;
          return a.op === "+" ? x + y : a.op === "-" ? x - y : x * y;
        }
        default:
          return compare(a.op, l, r);
      }
    }
    case "list":
      return a.items.map((x) => evalAst(x, scope, ctx));
  }
}

export function evaluate(source: string, scope: Scope): unknown {
  const p = parseExpr(source);
  return evalAst(p.ast, scope, { steps: 0, src: source });
}

export function evaluateBool(source: string, scope: Scope): boolean {
  return truthy(evaluate(source, scope));
}

/** Split a template like "/orders/{$rec.id}?tab={lower($rec.t)}" into literal and expression parts. */
export function parseTemplate(template: string): { lit: string; expr?: string }[] {
  const parts: { lit: string; expr?: string }[] = [];
  let i = 0;
  let lit = "";
  while (i < template.length) {
    const c = template[i]!;
    if (c === "{") {
      let depth = 1;
      let j = i + 1;
      let quote: string | null = null;
      while (j < template.length && depth > 0) {
        const d = template[j]!;
        if (quote) {
          if (d === quote) quote = null;
        } else if (d === "'" || d === '"') quote = d;
        else if (d === "{") depth++;
        else if (d === "}") depth--;
        j++;
      }
      if (depth !== 0) throw new ExprError("Unterminated {expr} in template", template, i);
      parts.push({ lit, expr: template.slice(i + 1, j - 1) });
      lit = "";
      i = j;
    } else {
      lit += c;
      i++;
    }
  }
  parts.push({ lit });
  return parts;
}

export function renderTemplate(template: string, scope: Scope): string {
  return parseTemplate(template)
    .map((p) => p.lit + (p.expr !== undefined ? asStr(evaluate(p.expr, scope)) : ""))
    .join("");
}

export function templateExprs(template: string): string[] {
  return parseTemplate(template)
    .filter((p) => p.expr !== undefined)
    .map((p) => p.expr!);
}

export { truthy, asStr as toStr, asNum as toNum };
