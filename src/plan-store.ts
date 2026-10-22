import { Database } from "bun:sqlite";

// `image` is an image id (the bytes live in the `images` table, see
// src/images.ts), never image bytes — the whole blob is re-uploaded on every
// save. `imageSize` is its natural [width, height], so the client can reserve
// the box before the bytes arrive.
export interface Entry { id: string; text: string; todo?: boolean; image?: string; imageSize?: [number, number] }
export interface List  { id: string; name: string; entries: Entry[] }
export interface Plan  { id: string; name: string; lists: List[]; background?: string }
export interface Data  { activePlanId: string; plans: Plan[]; version: number }

const BACKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // keep destructive-action backups for 1 week

// Everything lives in one SQLite file: the data blob (a single row), the image
// bytes, and the destructive-action backups. One file means one thing to back
// up, and a save is a single transaction — the blob write, its backup and the
// image cleanup it implies commit together or not at all.
export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("CREATE TABLE IF NOT EXISTS data (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, ct TEXT NOT NULL, at INTEGER NOT NULL, bytes BLOB NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS backups (at INTEGER PRIMARY KEY, json TEXT NOT NULL)");
  return db;
}

function listCount(plan: Plan): number {
  return Array.isArray(plan.lists) ? plan.lists.length : 0;
}

// True when `next` removes an entire plan or list relative to `current` — the
// destructive edits worth snapshotting so they can be rolled back. Entry-level
// changes and ordinary edits are intentionally ignored to keep backups sparse.
export function isDestructive(current: Data, next: Data): boolean {
  if (!Array.isArray(next.plans)) return false;
  if (next.plans.length < current.plans.length) return true; // a plan was deleted
  const nextById = new Map(next.plans.map((p) => [p.id, p]));
  for (const cur of current.plans) {
    const n = nextById.get(cur.id);
    if (n && listCount(n) < listCount(cur)) return true; // a list was deleted
  }
  return false;
}

// Snapshot `data` keyed by the time it was replaced, dropping any older than a
// week. Restoring is done by hand with sqlite3; see AGENTS.md.
export function backupData(db: Database, data: Data): void {
  const now = Date.now();
  db.query("INSERT OR REPLACE INTO backups (at, json) VALUES (?, ?)").run(now, JSON.stringify(data));
  db.query("DELETE FROM backups WHERE at < ?").run(now - BACKUP_TTL_MS);
}

function seed(): Data {
  const id = crypto.randomUUID();
  return { activePlanId: id, plans: [{ id, name: "Plan", lists: [] }], version: 1 };
}

export function getData(db: Database): Data {
  const row = db.query<{ json: string }, []>("SELECT json FROM data WHERE id = 1").get();
  const stored = row ? (JSON.parse(row.json) as Data) : null;
  if (stored && Array.isArray(stored.plans) && stored.plans.length > 0) {
    if (typeof stored.version !== "number") stored.version = 1; // migrate pre-versioning blobs
    return stored;
  }
  const fresh = seed();
  putData(db, fresh);
  return fresh;
}

export function putData(db: Database, data: Data): void {
  if (!data || !Array.isArray(data.plans)) throw new Error("invalid data");
  if (!data.plans.some(p => p.name === "Plan")) throw new Error("default plan 'Plan' is required");
  db.query("INSERT OR REPLACE INTO data (id, json) VALUES (1, ?)").run(JSON.stringify(data));
}
