import { createServer, type Server } from "node:http";

/**
 * Minimal fixture application for runtime tests (not the arena): a paginated item list, an
 * edit form that POSTs and redirects, and a detail page. Failure modes are toggled per test.
 */
export interface MiniApp {
  origin: string;
  items: Map<string, { id: string; name: string; status: string; notes: string[] }>;
  failNextWrite: "none" | "before-commit-503" | "after-commit-500";
  writes: number;
  /** Per-item activity log at /items/:id/activity (a titled list region with an add-entry form). */
  activity: Map<string, string[]>;
  /** Text shown in a separate "Elsewhere" region on the activity page (outside the Activity list). */
  decoy: string | null;
  /** Draft kept in the add-entry textarea (as apps do after a rejected submission). */
  draft: string | null;
  /**
   * Failure mode of activity POSTs. "silent-reject" answers 200 with an error and keeps the draft,
   * without committing; "-always" variants apply to every POST, the others only to the next one.
   */
  failActivity: "none" | "before-commit-503" | "after-commit-500" | "commit-twice" | "silent-reject" | "silent-reject-always";
  /** Activity entries committed (a double commit counts twice). */
  activityCommits: number;
  /** Requests to GET /logout, a state-changing GET route (it ends the session in real apps). */
  logouts: number;
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export async function startMiniApp(): Promise<MiniApp> {
  const items = new Map<string, { id: string; name: string; status: string; notes: string[] }>();
  for (let i = 1; i <= 23; i++) items.set(`I-${i}`, { id: `I-${i}`, name: `Item ${i}`, status: i % 3 === 0 ? "closed" : "open", notes: [] });
  const app: MiniApp = { origin: "", items, failNextWrite: "none", writes: 0, activity: new Map(), decoy: null, draft: null, failActivity: "none", activityCommits: 0, logouts: 0, close: async () => undefined };

  const page = (title: string, body: string) => `<!doctype html><html><head><title>${esc(title)}</title></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, html: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    };
    if (req.method === "GET" && url.pathname === "/") {
      // A home page, so a crawler starting at "/" reaches every route pattern.
      send(200, page("Mini", `<nav><a href="/items">Items</a> <a href="/items/I-1/activity">Recent activity</a></nav>`));
      return;
    }
    if (req.method === "GET" && url.pathname === "/logout") {
      app.logouts++;
      send(200, page("Signed out", "<p>You have been signed out.</p>"));
      return;
    }
    if (req.method === "GET" && url.pathname === "/items") {
      const p = Number(url.searchParams.get("page") ?? "1");
      const all = [...items.values()];
      const rows = all.slice((p - 1) * 10, p * 10);
      const pages = Math.ceil(all.length / 10);
      send(
        200,
        page(
          "Items",
          `<table><thead><tr><th>ID</th><th>Name</th><th>Status</th></tr></thead><tbody>${rows
            .map((r) => `<tr><td><a href="/items/${r.id}">${r.id}</a></td><td>${esc(r.name)}</td><td>${r.status}</td></tr>`)
            .join("")}</tbody></table><nav>${p < pages ? `<a href="/items?page=${p + 1}">Next page</a>` : `<span aria-disabled="true">Next page</span>`}</nav>`,
        ),
      );
      return;
    }
    const act = /^\/items\/([^/]+)\/activity$/.exec(url.pathname);
    const actItem = act ? items.get(decodeURIComponent(act[1]!)) : undefined;
    if (actItem) {
      const entries = app.activity.get(actItem.id) ?? [];
      const render = (status: number, error = "") =>
        send(
          status,
          page(
            `Activity ${actItem.id}`,
            `<section aria-labelledby="h-act"><h2 id="h-act">Activity</h2>${entries.length ? `<ul>${entries.map((e, i) => `<li><p>${esc(e)}</p><time>day ${i + 1}</time></li>`).join("")}</ul>` : `<p>No activity yet.</p>`}` +
              `${error ? `<p role="alert">${esc(error)}</p>` : ""}<form method="post" action="/items/${actItem.id}/activity"><label for="entry">Entry</label><textarea id="entry" name="body">${esc(app.draft ?? "")}</textarea><button type="submit">Add entry</button></form></section>` +
              (app.decoy ? `<section><h2>Elsewhere</h2><ul><li><p>${esc(app.decoy)}</p></li></ul></section>` : ""),
          ),
        );
      if (req.method === "GET") return render(200);
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const text = new URLSearchParams(body).get("body") ?? "";
        const mode = app.failActivity;
        if (!mode.endsWith("-always")) app.failActivity = "none";
        if (mode === "before-commit-503") return send(503, page("Unavailable", "<p>Try again</p>"));
        if (mode === "silent-reject" || mode === "silent-reject-always") {
          app.draft = text;
          return render(200, "Could not add the entry. Please try again.");
        }
        app.activity.set(actItem.id, [...entries, ...(mode === "commit-twice" ? [text, text] : [text])]);
        app.activityCommits += mode === "commit-twice" ? 2 : 1;
        if (mode === "after-commit-500") return send(500, page("Error", "<p>Internal error</p>"));
        res.writeHead(303, { location: `/items/${actItem.id}/activity` });
        res.end();
      });
      return;
    }
    const m = /^\/items\/([^/]+)(\/edit)?$/.exec(url.pathname);
    const item = m ? items.get(decodeURIComponent(m[1]!)) : undefined;
    if (req.method === "GET" && item && !m![2]) {
      send(200, page(`Item ${item.id}`, `<dl><dt>Status</dt><dd data-testid="status">${item.status}</dd><dt>Notes</dt><dd data-testid="notes">${item.notes.map(esc).join(" | ")}</dd></dl><a href="/items/${item.id}/edit">Edit</a>`));
      return;
    }
    if (req.method === "GET" && item && m![2]) {
      send(
        200,
        page(
          `Edit ${item.id}`,
          `<form method="post" action="/items/${item.id}/edit"><label for="st">Status</label><select id="st" name="status"><option value="open"${item.status === "open" ? " selected" : ""}>Open</option><option value="closed"${item.status === "closed" ? " selected" : ""}>Closed</option></select><label for="nt">Add note</label><input id="nt" name="note"><button type="submit">Save</button></form>`,
        ),
      );
      return;
    }
    if (req.method === "POST" && item && m![2]) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        if (app.failNextWrite === "before-commit-503") {
          app.failNextWrite = "none";
          send(503, page("Unavailable", "<p>Try again</p>"));
          return;
        }
        item.status = form.get("status") ?? item.status;
        const note = form.get("note");
        if (note) item.notes.push(note);
        app.writes++;
        if (app.failNextWrite === "after-commit-500") {
          app.failNextWrite = "none";
          send(500, page("Error", "<p>Internal error</p>"));
          return;
        }
        res.writeHead(303, { location: `/items/${item.id}` });
        res.end();
      });
      return;
    }
    send(404, page("Not found", ""));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  app.origin = `http://127.0.0.1:${addr.port}`;
  app.close = () => new Promise((r) => server.close(() => r()));
  return app;
}
