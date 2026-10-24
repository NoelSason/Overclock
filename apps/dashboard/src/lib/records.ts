/** Parse the records box: a JSON array of objects, or CSV with a header row. */

export type Row = Record<string, unknown>;

export type ParsedRecords = { ok: true; records: Row[]; format: "json" | "csv" | "empty" } | { ok: false; error: string };

export function parseRecords(text: string): ParsedRecords {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, records: [], format: "empty" };
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const value: unknown = JSON.parse(trimmed);
      const list = Array.isArray(value) ? value : [value];
      if (!list.every((r): r is Row => typeof r === "object" && r !== null && !Array.isArray(r))) return { ok: false, error: "JSON must be an array of objects" };
      return { ok: true, records: list, format: "json" };
    } catch (e) {
      return { ok: false, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const rows = parseCsv(trimmed);
  const header = rows[0];
  if (!header || header.length === 0) return { ok: false, error: "CSV needs a header row" };
  const records = rows.slice(1).filter((r) => r.some((c) => c !== "")).map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), coerce(r[i] ?? "")])));
  return { ok: true, records, format: "csv" };
}

function coerce(cell: string): unknown {
  const t = cell.trim();
  if (t === "") return "";
  if (/^-?\d+(\.\d+)?$/.test(t) && !/^0\d/.test(t)) return Number(t);
  if (t === "true" || t === "false") return t === "true";
  return t;
}

/** RFC 4180-ish CSV: quoted fields, escaped quotes, CRLF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}
