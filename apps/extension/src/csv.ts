/**
 * Records from a CSV file, checked against the fields a workflow expects. The engine checks the
 * records again before anything runs; this gives the customer the same answer before they submit.
 */
export type Row = Record<string, string>;

/** RFC 4180 rows: quoted fields, "" escapes, embedded commas and newlines, LF/CRLF/CR endings. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
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
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

export interface ParsedRecords {
  records: Row[];
  columns: string[];
  errors: string[];
}

const MAX_RECORDS = 1000;

/**
 * Parse a CSV whose header row names the record fields. With `expected` (a learned workflow's
 * fields), the header must be exactly those fields, in any order.
 */
export function parseRecordsCsv(text: string, expected?: string[]): ParsedRecords {
  const rows = parseCsvRows(text);
  if (!rows.length) return { records: [], columns: [], errors: ["The file is empty."] };
  const columns = rows[0]!.map((c) => c.trim());
  const errors: string[] = [];
  if (columns.some((c) => !c)) errors.push("Every column needs a name in the first row.");
  const dupes = columns.filter((c, i) => columns.indexOf(c) !== i);
  if (dupes.length) errors.push(`Repeated column: ${[...new Set(dupes)].join(", ")}.`);
  if (expected) {
    const missing = expected.filter((f) => !columns.includes(f));
    const extra = columns.filter((c) => !expected.includes(c));
    if (missing.length) errors.push(`Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. This workflow needs ${expected.join(", ")}.`);
    if (extra.length) errors.push(`Unexpected column${extra.length > 1 ? "s" : ""}: ${extra.join(", ")}. This workflow uses only ${expected.join(", ")}.`);
  }
  const body = rows.slice(1);
  if (!body.length) errors.push("The file has a header row but no records.");
  if (body.length > MAX_RECORDS) errors.push(`At most ${MAX_RECORDS} records per run; this file has ${body.length}.`);
  const records: Row[] = [];
  const seen = new Set<string>();
  for (const [i, cells] of body.slice(0, MAX_RECORDS).entries()) {
    const line = i + 2;
    if (cells.length !== columns.length) {
      errors.push(`Line ${line} has ${cells.length} values; the header has ${columns.length}.`);
      continue;
    }
    const r: Row = {};
    columns.forEach((c, j) => (r[c] = cells[j]!.trim()));
    const empty = columns.filter((c) => !r[c]);
    if (empty.length) errors.push(`Line ${line} is missing ${empty.join(", ")}.`);
    const id = columns.map((c) => r[c]).join("\u0000");
    if (seen.has(id)) errors.push(`Line ${line} repeats an earlier record.`);
    seen.add(id);
    records.push(r);
  }
  return { records, columns, errors: errors.slice(0, 8) };
}
