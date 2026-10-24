/** Tiny argv parser: `--flag`, `--flag value`, `--flag=value`, repeatable flags, and `--`. */

export type FlagKind = "boolean" | "string" | "multi";
export type FlagSpec = Record<string, FlagKind>;
export type FlagValue = string | boolean | string[];

export interface ParsedArgs {
  flags: Record<string, FlagValue | undefined>;
  positionals: string[];
}

/** Bad invocation: unknown command or flag, missing or malformed value. Exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseArgs(argv: readonly string[], spec: FlagSpec): ParsedArgs {
  const flags: Record<string, FlagValue | undefined> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h") {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const kind = spec[name];
    if (kind === undefined) throw new UsageError(`Unknown option --${name}`);
    if (kind === "boolean") {
      if (eq !== -1) throw new UsageError(`--${name} does not take a value`);
      flags[name] = true;
      continue;
    }
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new UsageError(`--${name} needs a value`);
      value = next;
      i++;
    }
    if (kind === "multi") {
      const prev = flags[name];
      flags[name] = Array.isArray(prev) ? [...prev, value] : [value];
    } else {
      flags[name] = value;
    }
  }
  return { flags, positionals };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}

export function flagList(args: ParsedArgs, name: string): string[] {
  const v = args.flags[name];
  return Array.isArray(v) ? v : [];
}

export function flagInt(args: ParsedArgs, name: string, min: number, max: number): number | undefined {
  const raw = flagString(args, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) throw new UsageError(`--${name} must be an integer from ${min} to ${max}, got "${raw}"`);
  return n;
}

export function flagChoice<T extends string>(args: ParsedArgs, name: string, choices: readonly T[]): T | undefined {
  const raw = flagString(args, name);
  if (raw === undefined) return undefined;
  const match = choices.find((c) => c === raw);
  if (match === undefined) throw new UsageError(`--${name} must be one of ${choices.join(", ")}; got "${raw}"`);
  return match;
}

/** The one required positional argument, e.g. a run id. */
export function positional(args: ParsedArgs, index: number, label: string): string {
  const v = args.positionals[index];
  if (v === undefined || v === "") throw new UsageError(`Missing <${label}>`);
  return v;
}
