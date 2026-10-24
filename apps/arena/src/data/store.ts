import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HOLDOUT_DB_FILE } from "../holdout/meta";
import { emptyHoldout } from "../holdout/model";
import { HoldoutStore } from "../holdout/store";
import type { Customer, CustomerStatus, Dataset, Note, Order, Ticket } from "./model";

/**
 * Persistent storage for the four arena applications. Each application owns a separate
 * SQLite database file; nothing joins across them, exactly like unrelated SaaS tools.
 */

export interface ListQuery {
  q?: string | undefined;
  page: number;
  pageSize: number;
  status?: string | undefined;
  category?: string | undefined;
  customerId?: string | undefined;
}

export interface ListResult<T> {
  rows: T[];
  total: number;
  page: number;
  pages: number;
}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function open(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  return db;
}

function list<T>(db: DatabaseSync, table: string, where: string[], params: Record<string, string | number>, order: string, q: ListQuery): ListResult<T> {
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${w}`).get(params) as { n: number }).n;
  const pages = Math.max(1, Math.ceil(total / q.pageSize));
  const page = Math.min(Math.max(1, q.page), pages);
  const rows = db.prepare(`SELECT * FROM ${table} ${w} ORDER BY ${order} LIMIT ${q.pageSize} OFFSET ${(page - 1) * q.pageSize}`).all(params) as T[];
  return { rows, total, page, pages };
}

export class CrmStore {
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, city TEXT NOT NULL,
      status TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS customers_email ON customers(email);`);
  }
  list(q: ListQuery): ListResult<Customer> {
    const where: string[] = [];
    const params: Record<string, string | number> = {};
    if (q.q) {
      where.push("(id LIKE $q OR name LIKE $q OR email LIKE $q)");
      params.$q = `%${q.q}%`;
    }
    if (q.status) {
      where.push("status = $status");
      params.$status = q.status;
    }
    return list<Customer>(this.db, "customers", where, params, "name ASC, id ASC", q);
  }
  get(id: string): Customer | undefined {
    return this.db.prepare("SELECT * FROM customers WHERE id = ?").get(id) as Customer | undefined;
  }
  byEmail(email: string): Customer[] {
    return this.db.prepare("SELECT * FROM customers WHERE lower(email) = lower(?) ORDER BY id").all(email) as unknown as Customer[];
  }
  update(id: string, patch: Partial<Pick<Customer, "name" | "email" | "phone" | "city" | "status">>): Customer | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, updated_at: now(), version: cur.version + 1 };
    this.db.prepare("UPDATE customers SET name=$name, email=$email, phone=$phone, city=$city, status=$status, updated_at=$updated_at, version=$version WHERE id=$id").run({
      $name: next.name,
      $email: next.email,
      $phone: next.phone,
      $city: next.city,
      $status: next.status,
      $updated_at: next.updated_at,
      $version: next.version,
      $id: id,
    });
    return next;
  }
  /** Bulk status import (CSV page): returns per-row results. */
  bulkSetStatus(rows: { id: string; status: CustomerStatus }[]): { id: string; ok: boolean; error?: string }[] {
    const out: { id: string; ok: boolean; error?: string }[] = [];
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        if (!this.get(r.id)) out.push({ id: r.id, ok: false, error: "Unknown customer" });
        else {
          this.update(r.id, { status: r.status });
          out.push({ id: r.id, ok: true });
        }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return out;
  }
  all(): Customer[] {
    return this.db.prepare("SELECT * FROM customers ORDER BY id").all() as unknown as Customer[];
  }
  replace(rows: Customer[]): void {
    this.db.exec("BEGIN; DELETE FROM customers;");
    const ins = this.db.prepare("INSERT INTO customers (id,name,email,phone,city,status,updated_at,version) VALUES (?,?,?,?,?,?,?,?)");
    for (const c of rows) ins.run(c.id, c.name, c.email, c.phone, c.city, c.status, c.updated_at, c.version);
    this.db.exec("COMMIT");
  }
}

export class OrdersStore {
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, customer_email TEXT NOT NULL, status TEXT NOT NULL, total REAL NOT NULL,
      tracking TEXT NOT NULL, placed_at TEXT NOT NULL, review_flag INTEGER NOT NULL, review_reason TEXT NOT NULL,
      updated_at TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS orders_customer ON orders(customer_id);`);
  }
  list(q: ListQuery): ListResult<Order> {
    const where: string[] = [];
    const params: Record<string, string | number> = {};
    if (q.q) {
      where.push("(id LIKE $q OR customer_id LIKE $q OR customer_email LIKE $q)");
      params.$q = `%${q.q}%`;
    }
    if (q.status) {
      where.push("status = $status");
      params.$status = q.status;
    }
    if (q.customerId) {
      where.push("customer_id = $cid");
      params.$cid = q.customerId;
    }
    return list<Order>(this.db, "orders", where, params, "placed_at DESC, id ASC", q);
  }
  get(id: string): Order | undefined {
    return this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as Order | undefined;
  }
  update(id: string, patch: Partial<Pick<Order, "customer_id" | "status" | "tracking" | "review_flag" | "review_reason">>): Order | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, updated_at: now(), version: cur.version + 1 };
    this.db
      .prepare("UPDATE orders SET customer_id=$customer_id, status=$status, tracking=$tracking, review_flag=$review_flag, review_reason=$review_reason, updated_at=$updated_at, version=$version WHERE id=$id")
      .run({ $customer_id: next.customer_id, $status: next.status, $tracking: next.tracking, $review_flag: next.review_flag, $review_reason: next.review_reason, $updated_at: next.updated_at, $version: next.version, $id: id });
    return next;
  }
  all(): Order[] {
    return this.db.prepare("SELECT * FROM orders ORDER BY id").all() as unknown as Order[];
  }
  replace(rows: Order[]): void {
    this.db.exec("BEGIN; DELETE FROM orders;");
    const ins = this.db.prepare("INSERT INTO orders (id,customer_id,customer_email,status,total,tracking,placed_at,review_flag,review_reason,updated_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    for (const o of rows) ins.run(o.id, o.customer_id, o.customer_email, o.status, o.total, o.tracking, o.placed_at, o.review_flag, o.review_reason, o.updated_at, o.version);
    this.db.exec("COMMIT");
  }
}

export class SupportStore {
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL, customer_email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
      category TEXT NOT NULL, status TEXT NOT NULL, owner TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS tickets_order ON tickets(order_id);
      CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS notes_ticket ON notes(ticket_id);`);
  }
  list(q: ListQuery): ListResult<Ticket> {
    const where: string[] = [];
    const params: Record<string, string | number> = {};
    if (q.q) {
      where.push("(id LIKE $q OR order_id LIKE $q OR customer_email LIKE $q OR subject LIKE $q)");
      params.$q = `%${q.q}%`;
    }
    if (q.status) {
      where.push("status = $status");
      params.$status = q.status;
    }
    if (q.category) {
      where.push("category = $category");
      params.$category = q.category;
    }
    return list<Ticket>(this.db, "tickets", where, params, "updated_at DESC, id ASC", q);
  }
  get(id: string): Ticket | undefined {
    return this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as Ticket | undefined;
  }
  byOrder(orderId: string): Ticket[] {
    return this.db.prepare("SELECT * FROM tickets WHERE order_id = ? ORDER BY id").all(orderId) as unknown as Ticket[];
  }
  update(id: string, patch: Partial<Pick<Ticket, "category" | "status" | "owner">>): Ticket | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, updated_at: now(), version: cur.version + 1 };
    this.db.prepare("UPDATE tickets SET category=$category, status=$status, owner=$owner, updated_at=$updated_at, version=$version WHERE id=$id").run({
      $category: next.category,
      $status: next.status,
      $owner: next.owner,
      $updated_at: next.updated_at,
      $version: next.version,
      $id: id,
    });
    return next;
  }
  notes(ticketId: string): Note[] {
    return this.db.prepare("SELECT * FROM notes WHERE ticket_id = ? ORDER BY id").all(ticketId) as unknown as Note[];
  }
  addNote(ticketId: string, body: string): Note {
    const created_at = now();
    const r = this.db.prepare("INSERT INTO notes (ticket_id, body, created_at) VALUES (?,?,?)").run(ticketId, body, created_at);
    return { id: Number(r.lastInsertRowid), ticket_id: ticketId, body, created_at };
  }
  all(): Ticket[] {
    return this.db.prepare("SELECT * FROM tickets ORDER BY id").all() as unknown as Ticket[];
  }
  allNotes(): Note[] {
    return this.db.prepare("SELECT * FROM notes ORDER BY id").all() as unknown as Note[];
  }
  replace(rows: Ticket[], notes: Note[]): void {
    this.db.exec("BEGIN; DELETE FROM tickets; DELETE FROM notes; DELETE FROM sqlite_sequence WHERE name = 'notes';");
    const ins = this.db.prepare("INSERT INTO tickets (id,order_id,customer_email,subject,body,category,status,owner,updated_at,version) VALUES (?,?,?,?,?,?,?,?,?,?)");
    for (const t of rows) ins.run(t.id, t.order_id, t.customer_email, t.subject, t.body, t.category, t.status, t.owner, t.updated_at, t.version);
    const insN = this.db.prepare("INSERT INTO notes (id, ticket_id, body, created_at) VALUES (?,?,?,?)");
    for (const n of notes) insN.run(n.id, n.ticket_id, n.body, n.created_at);
    this.db.exec("COMMIT");
  }
}

export class ArenaStore {
  readonly crm: CrmStore;
  readonly orders: OrdersStore;
  readonly support: SupportStore;
  readonly holdout: HoldoutStore;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.crm = new CrmStore(open(join(dir, "crm.db")));
    this.orders = new OrdersStore(open(join(dir, "orders.db")));
    this.support = new SupportStore(open(join(dir, "support.db")));
    this.holdout = new HoldoutStore(open(join(dir, HOLDOUT_DB_FILE)));
  }

  /** Snapshot restore: replace every table with the given dataset. */
  load(d: Dataset): void {
    this.crm.replace(d.customers);
    this.orders.replace(d.orders);
    this.support.replace(d.tickets, d.notes);
    this.holdout.replace(d.holdout ?? emptyHoldout());
  }

  dump(): Dataset {
    return { customers: this.crm.all(), orders: this.orders.all(), tickets: this.support.all(), notes: this.support.allNotes(), holdout: this.holdout.dump() };
  }

  close(): void {
    this.crm.db.close();
    this.orders.db.close();
    this.support.db.close();
    this.holdout.db.close();
  }
}
