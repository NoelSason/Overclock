"use client";

import { useState, type ReactNode } from "react";
import { cx } from "./primitives";

/**
 * Generic, readable rendering of artifact JSON: objects become key/value lists, arrays of
 * similar objects become tables, everything nested is collapsible. Large arrays are paged.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const PAGE = 50;
const MAX_TABLE_COLS = 10;

function isObject(v: unknown): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function Primitive({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-dim">null</span>;
  if (typeof value === "boolean") return <span className={value ? "text-ok" : "text-bad"}>{String(value)}</span>;
  if (typeof value === "number") return <span className="tnum text-accent-soft">{Number.isInteger(value) ? value : value.toFixed(4).replace(/0+$/, "")}</span>;
  const s = String(value);
  return <span className="break-words whitespace-pre-wrap text-fg">{s}</span>;
}

function summarize(v: Json): string {
  if (Array.isArray(v)) return `[${v.length}]`;
  if (isObject(v)) return `{${Object.keys(v).length}}`;
  return "";
}

/** Columns for an array of objects whose values are mostly primitives. */
function tableColumns(rows: Json[]): string[] | null {
  if (rows.length < 2 || !rows.every(isObject)) return null;
  const keys = new Map<string, number>();
  for (const r of rows as Record<string, Json>[]) for (const k of Object.keys(r)) keys.set(k, (keys.get(k) ?? 0) + 1);
  const cols = [...keys.entries()].filter(([, n]) => n >= rows.length / 2).map(([k]) => k);
  if (cols.length === 0 || cols.length > MAX_TABLE_COLS) return null;
  return cols;
}

function Node({ value, depth }: { value: Json; depth: number }) {
  if (Array.isArray(value)) return <ArrayNode items={value} depth={depth} />;
  if (isObject(value)) return <ObjectNode obj={value} depth={depth} />;
  return <Primitive value={value} />;
}

function Collapsible({ label, summary, depth, children }: { label: string; summary: string; depth: number; children: ReactNode }) {
  const [open, setOpen] = useState(depth < 2);
  return (
    <div className="min-w-0">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-1 rounded text-left text-muted hover:text-fg">
        <span aria-hidden className={cx("inline-block w-3 text-[10px] transition-transform", open && "rotate-90")}>
          ▸
        </span>
        <span className="font-medium">{label}</span>
        <span className="text-dim">{summary}</span>
      </button>
      {open && <div className="mt-1 ml-1.5 border-l border-line pl-3">{children}</div>}
    </div>
  );
}

function ObjectNode({ obj, depth }: { obj: Record<string, Json>; depth: number }) {
  const entries = Object.entries(obj);
  if (entries.length === 0) return <span className="text-dim">{"{}"}</span>;
  return (
    <div className="flex flex-col gap-1">
      {entries.map(([k, v]) =>
        typeof v === "object" && v !== null ? (
          <Collapsible key={k} label={k} summary={summarize(v)} depth={depth}>
            <Node value={v} depth={depth + 1} />
          </Collapsible>
        ) : (
          <div key={k} className="grid grid-cols-[minmax(80px,max-content)_minmax(0,1fr)] gap-3">
            <span className="text-muted">{k}</span>
            <Primitive value={v} />
          </div>
        ),
      )}
    </div>
  );
}

function ArrayNode({ items, depth }: { items: Json[]; depth: number }) {
  const [shown, setShown] = useState(PAGE);
  if (items.length === 0) return <span className="text-dim">[]</span>;
  const visible = items.slice(0, shown);
  const cols = tableColumns(items);
  const more = items.length > shown && (
    <button type="button" className="mt-1 text-accent-soft hover:underline" onClick={() => setShown((s) => s + PAGE)}>
      Show {Math.min(PAGE, items.length - shown)} more of {items.length - shown}
    </button>
  );
  if (cols) {
    return (
      <div className="min-w-0">
        <div className="overflow-x-auto rounded border border-line">
          <table className="w-full text-left text-[12px]">
            <thead className="bg-raised text-muted">
              <tr>
                {cols.map((c) => (
                  <th key={c} scope="col" className="px-2 py-1 font-medium whitespace-nowrap">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(visible as Record<string, Json>[]).map((row, i) => (
                <tr key={i} className="border-t border-line align-top">
                  {cols.map((c) => {
                    const v = row[c];
                    return (
                      <td key={c} className="max-w-[280px] px-2 py-1">
                        {v !== undefined && typeof v === "object" && v !== null ? (
                          <Collapsible label="" summary={summarize(v)} depth={9}>
                            <Node value={v} depth={depth + 1} />
                          </Collapsible>
                        ) : (
                          <Primitive value={v} />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {more}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {visible.map((v, i) =>
        typeof v === "object" && v !== null ? (
          <Collapsible key={i} label={`${i}`} summary={summarize(v)} depth={depth}>
            <Node value={v} depth={depth + 1} />
          </Collapsible>
        ) : (
          <div key={i} className="grid grid-cols-[24px_minmax(0,1fr)] gap-2">
            <span className="text-dim">{i}</span>
            <Primitive value={v} />
          </div>
        ),
      )}
      {more}
    </div>
  );
}

export function JsonView({ value }: { value: unknown }) {
  const [raw, setRaw] = useState(false);
  return (
    <div className="font-mono text-[12px] leading-5">
      <div className="mb-2 flex justify-end">
        <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => setRaw((r) => !r)} aria-pressed={raw}>
          {raw ? "Structured view" : "Raw JSON"}
        </button>
      </div>
      {raw ? <pre className="overflow-auto rounded border border-line bg-sunken p-3 whitespace-pre-wrap text-fg">{JSON.stringify(value, null, 2)}</pre> : <Node value={value as Json} depth={0} />}
    </div>
  );
}
