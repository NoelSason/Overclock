// HOLDOUT FIXTURE — engine/prompt developers must not read this file.
import type { DatabaseSync } from "node:sqlite";
import type { CustodyEntry, Excursion, HoldoutData, Participant, Specimen, Unit } from "./model";

/** SQLite storage for the holdout application. One database file, owned by this app only. */

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export interface Slice<T> {
  rows: T[];
  total: number;
}

type Params = Record<string, string | number>;

export type SpecimenPatch = Partial<Pick<Specimen, "state" | "hold" | "hold_reason" | "position" | "handling_note" | "label_code" | "participant_code" | "unit_id" | "material" | "stored_at">>;

export class HoldoutStore {
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS specimens (
      accession TEXT PRIMARY KEY, label_code TEXT NOT NULL, material TEXT NOT NULL, participant_code TEXT NOT NULL, unit_id TEXT NOT NULL,
      position TEXT NOT NULL, stored_at TEXT NOT NULL, state TEXT NOT NULL, hold INTEGER NOT NULL, hold_reason TEXT NOT NULL,
      handling_note TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS specimens_label ON specimens(label_code);
      CREATE INDEX IF NOT EXISTS specimens_participant ON specimens(participant_code);
      CREATE INDEX IF NOT EXISTS specimens_unit ON specimens(unit_id);
      CREATE TABLE IF NOT EXISTS participants (code TEXT PRIMARY KEY, consent TEXT NOT NULL, consent_updated_at TEXT NOT NULL, site TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS units (id TEXT PRIMARY KEY, name TEXT NOT NULL, location TEXT NOT NULL, setpoint_c REAL NOT NULL, service TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS excursions (id TEXT PRIMARY KEY, unit_id TEXT NOT NULL, started_at TEXT NOT NULL, peak_c REAL NOT NULL, duration_min INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS excursions_unit ON excursions(unit_id);
      CREATE TABLE IF NOT EXISTS custody (id INTEGER PRIMARY KEY AUTOINCREMENT, accession TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS custody_accession ON custody(accession);`);
  }

  private slice<T>(table: string, where: string[], params: Params, order: string, offset: number, limit: number): Slice<T> {
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${w}`).get(params) as { n: number }).n;
    const rows = this.db.prepare(`SELECT * FROM ${table} ${w} ORDER BY ${order} LIMIT ${Math.max(0, limit)} OFFSET ${Math.max(0, offset)}`).all(params) as unknown as T[];
    return { rows, total };
  }

  // Specimens -------------------------------------------------------------------------------

  listSpecimens(q: { q?: string | undefined; state?: string | undefined; offset: number; limit: number }): Slice<Specimen> {
    const where: string[] = [];
    const params: Params = {};
    if (q.q) {
      where.push("(accession LIKE $q OR label_code LIKE $q OR participant_code LIKE $q)");
      params.$q = `%${q.q}%`;
    }
    if (q.state) {
      where.push("state = $state");
      params.$state = q.state;
    }
    return this.slice<Specimen>("specimens", where, params, "stored_at DESC, accession ASC", q.offset, q.limit);
  }

  getSpecimen(accession: string): Specimen | undefined {
    return this.db.prepare("SELECT * FROM specimens WHERE accession = ?").get(accession) as Specimen | undefined;
  }

  specimensOfParticipant(code: string): Specimen[] {
    return this.db.prepare("SELECT * FROM specimens WHERE participant_code = ? ORDER BY stored_at DESC, accession").all(code) as unknown as Specimen[];
  }

  /** Specimens per participant or per storage unit. */
  specimenCounts(column: "participant_code" | "unit_id"): Map<string, number> {
    const rows = this.db.prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM specimens GROUP BY ${column}`).all() as unknown as { k: string; n: number }[];
    return new Map(rows.map((r) => [r.k, r.n]));
  }

  countInUnit(unitId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM specimens WHERE unit_id = ?").get(unitId) as { n: number }).n;
  }

  updateSpecimen(accession: string, patch: SpecimenPatch): Specimen | undefined {
    const cur = this.getSpecimen(accession);
    if (!cur) return undefined;
    const next: Specimen = { ...cur, ...patch, updated_at: now(), version: cur.version + 1 };
    this.db
      .prepare(
        `UPDATE specimens SET label_code=$label_code, material=$material, participant_code=$participant_code, unit_id=$unit_id, position=$position,
         stored_at=$stored_at, state=$state, hold=$hold, hold_reason=$hold_reason, handling_note=$handling_note, updated_at=$updated_at, version=$version
         WHERE accession=$accession`,
      )
      .run({
        $label_code: next.label_code,
        $material: next.material,
        $participant_code: next.participant_code,
        $unit_id: next.unit_id,
        $position: next.position,
        $stored_at: next.stored_at,
        $state: next.state,
        $hold: next.hold,
        $hold_reason: next.hold_reason,
        $handling_note: next.handling_note,
        $updated_at: next.updated_at,
        $version: next.version,
        $accession: accession,
      });
    return next;
  }

  // Custody log (append-only) ---------------------------------------------------------------

  /** Newest first. `beforeId` pages to older entries. */
  custody(accession: string, opts: { beforeId?: number | undefined; limit: number }): { entries: CustodyEntry[]; more: boolean } {
    const before = opts.beforeId ?? Number.MAX_SAFE_INTEGER;
    const rows = this.db.prepare("SELECT * FROM custody WHERE accession = ? AND id < ? ORDER BY id DESC LIMIT ?").all(accession, before, opts.limit + 1) as unknown as CustodyEntry[];
    return { entries: rows.slice(0, opts.limit), more: rows.length > opts.limit };
  }

  addCustody(accession: string, text: string, actor: string): CustodyEntry {
    const at = now();
    const r = this.db.prepare("INSERT INTO custody (accession, text, at, actor) VALUES (?,?,?,?)").run(accession, text, at, actor);
    return { id: Number(r.lastInsertRowid), accession, text, at, actor };
  }

  // Participants ----------------------------------------------------------------------------

  listParticipants(q: { q?: string | undefined; offset: number; limit: number }): Slice<Participant> {
    const where: string[] = [];
    const params: Params = {};
    if (q.q) {
      where.push("(code LIKE $q OR site LIKE $q)");
      params.$q = `%${q.q}%`;
    }
    return this.slice<Participant>("participants", where, params, "code ASC", q.offset, q.limit);
  }

  getParticipant(code: string): Participant | undefined {
    return this.db.prepare("SELECT * FROM participants WHERE code = ?").get(code) as Participant | undefined;
  }

  updateParticipant(code: string, patch: Partial<Pick<Participant, "consent" | "site">>): Participant | undefined {
    const cur = this.getParticipant(code);
    if (!cur) return undefined;
    const next: Participant = { ...cur, ...patch, consent_updated_at: patch.consent && patch.consent !== cur.consent ? now() : cur.consent_updated_at, version: cur.version + 1 };
    this.db.prepare("UPDATE participants SET consent=$consent, consent_updated_at=$cu, site=$site, version=$version WHERE code=$code").run({
      $consent: next.consent,
      $cu: next.consent_updated_at,
      $site: next.site,
      $version: next.version,
      $code: code,
    });
    return next;
  }

  // Storage units and excursions ------------------------------------------------------------

  listUnits(): Unit[] {
    return this.db.prepare("SELECT * FROM units ORDER BY id").all() as unknown as Unit[];
  }

  getUnit(id: string): Unit | undefined {
    return this.db.prepare("SELECT * FROM units WHERE id = ?").get(id) as Unit | undefined;
  }

  updateUnit(id: string, patch: Partial<Pick<Unit, "service">>): Unit | undefined {
    const cur = this.getUnit(id);
    if (!cur) return undefined;
    const next: Unit = { ...cur, ...patch, updated_at: now(), version: cur.version + 1 };
    this.db.prepare("UPDATE units SET service=$service, updated_at=$updated_at, version=$version WHERE id=$id").run({ $service: next.service, $updated_at: next.updated_at, $version: next.version, $id: id });
    return next;
  }

  /** Newest first. */
  excursions(unitId: string, offset: number, limit: number): Slice<Excursion> {
    return this.slice<Excursion>("excursions", ["unit_id = $unit"], { $unit: unitId }, "started_at DESC, id DESC", offset, limit);
  }

  // Snapshot --------------------------------------------------------------------------------

  dump(): HoldoutData {
    return {
      specimens: this.db.prepare("SELECT * FROM specimens ORDER BY accession").all() as unknown as Specimen[],
      participants: this.db.prepare("SELECT * FROM participants ORDER BY code").all() as unknown as Participant[],
      units: this.listUnits(),
      excursions: this.db.prepare("SELECT * FROM excursions ORDER BY id").all() as unknown as Excursion[],
      custody: this.db.prepare("SELECT * FROM custody ORDER BY id").all() as unknown as CustodyEntry[],
    };
  }

  replace(d: HoldoutData): void {
    this.db.exec("BEGIN; DELETE FROM specimens; DELETE FROM participants; DELETE FROM units; DELETE FROM excursions; DELETE FROM custody; DELETE FROM sqlite_sequence WHERE name = 'custody';");
    try {
      const s = this.db.prepare(
        "INSERT INTO specimens (accession,label_code,material,participant_code,unit_id,position,stored_at,state,hold,hold_reason,handling_note,updated_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      );
      for (const x of d.specimens) s.run(x.accession, x.label_code, x.material, x.participant_code, x.unit_id, x.position, x.stored_at, x.state, x.hold, x.hold_reason, x.handling_note, x.updated_at, x.version);
      const p = this.db.prepare("INSERT INTO participants (code,consent,consent_updated_at,site,version) VALUES (?,?,?,?,?)");
      for (const x of d.participants) p.run(x.code, x.consent, x.consent_updated_at, x.site, x.version);
      const u = this.db.prepare("INSERT INTO units (id,name,location,setpoint_c,service,updated_at,version) VALUES (?,?,?,?,?,?,?)");
      for (const x of d.units) u.run(x.id, x.name, x.location, x.setpoint_c, x.service, x.updated_at, x.version);
      const e = this.db.prepare("INSERT INTO excursions (id,unit_id,started_at,peak_c,duration_min) VALUES (?,?,?,?,?)");
      for (const x of d.excursions) e.run(x.id, x.unit_id, x.started_at, x.peak_c, x.duration_min);
      const c = this.db.prepare("INSERT INTO custody (id,accession,text,at,actor) VALUES (?,?,?,?,?)");
      for (const x of d.custody) c.run(x.id, x.accession, x.text, x.at, x.actor);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
