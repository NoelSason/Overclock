import { readFile } from "node:fs/promises";
import { extname } from "node:path";

/** Loads run records from a CSV (header row + rows) or JSON (array, or `{ records: [...] }`) file. */

export type RecordRow = Record<string, unknown>;

function isRow(v: unknown): v is RecordRow {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseJsonRecords(text: string, source: string): RecordRow[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source} is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const list = Array.isArray(value) ? value : isRow(value) && Array.isArray(value.records) ? value.records : undefined;
  if (list === undefined) throw new Error(`${source} must contain a JSON array of records or an object with a "records" array`);
  const rows: RecordRow[] = [];
  for (const [i, item] of list.entries()) {
    if (!isRow(item)) throw new Error(`${source}: record ${i + 1} is not an object`);
    rows.push(item);
  }
  return rows;
}

/** RFC 4180 rows: quoted fields, "" escapes, embedded commas and newlines, LF/CRLF/CR endings. */
function csvRows(text: string, source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) throw new Error(`${source}: unterminated quoted field`);
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0]?.trim() === ""));
}

export function parseCsvRecords(text: string, source: string): RecordRow[] {
  const [header, ...body] = csvRows(text, source);
  if (header === undefined) return [];
  const keys = header.map((h) => h.trim());
  if (keys.some((k) => k === "")) throw new Error(`${source}: the header row has an empty column name`);
  return body.map((cells, n) => {
    if (cells.length > keys.length) throw new Error(`${source}: row ${n + 2} has ${cells.length} fields but the header has ${keys.length}`);
    const row: RecordRow = {};
    keys.forEach((k, i) => {
      row[k] = cells[i] ?? "";
    });
    return row;
  });
}

export async function loadRecords(path: string): Promise<RecordRow[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`Cannot read records file ${path} (${err instanceof Error && "code" in err ? String(err.code) : String(err)})`);
  }
  const ext = extname(path).toLowerCase();
  if (ext === ".json") return parseJsonRecords(text, path);
  if (ext === ".csv") return parseCsvRecords(text, path);
  const first = text.trimStart()[0];
  return first === "[" || first === "{" ? parseJsonRecords(text, path) : parseCsvRecords(text, path);
}
