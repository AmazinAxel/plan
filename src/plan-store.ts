export interface Entry { id: string; text: string; todo?: boolean }
export interface List  { id: string; name: string; entries: Entry[] }
export interface Plan  { id: string; name: string; lists: List[]; background?: string }
export interface Data  { activePlanId: string; plans: Plan[]; version: number }

const DATA_KEY = "data";
const BACKUP_TTL_SECONDS = 7 * 24 * 60 * 60; // keep destructive-action backups for 1 week

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

// A US/Los_Angeles timestamp formatted as mm-dd-yyyy--hh-mm (24-hour, no
// seconds) for readable backup keys in the Cloudflare dashboard.
function backupTimestamp(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.month}-${p.day}-${p.year}--${p.hour}-${p.minute}`;
}

// Snapshot `data` under a timestamped, auto-expiring key. The keys appear in the
// Cloudflare KV dashboard as `backup:<mm-dd-yyyy--hh-mm>` (Los Angeles time); to
// restore, copy a backup's value back into the `data` key.
export async function backupData(kv: KVNamespace, data: Data): Promise<void> {
  const key = `backup:${backupTimestamp()}`;
  await kv.put(key, JSON.stringify(data), { expirationTtl: BACKUP_TTL_SECONDS });
}

function seed(): Data {
  const id = crypto.randomUUID();
  return { activePlanId: id, plans: [{ id, name: "Plan", lists: [] }], version: 1 };
}

export async function getData(kv: KVNamespace): Promise<Data> {
  const stored = await kv.get<Data>(DATA_KEY, "json");
  if (stored && Array.isArray(stored.plans) && stored.plans.length > 0) {
    if (typeof stored.version !== "number") stored.version = 1; // migrate pre-versioning blobs
    return stored;
  }
  const fresh = seed();
  await kv.put(DATA_KEY, JSON.stringify(fresh));
  return fresh;
}

export async function putData(kv: KVNamespace, data: Data): Promise<void> {
  if (!data || !Array.isArray(data.plans)) throw new Error("invalid data");
  if (!data.plans.some(p => p.name === "Plan")) throw new Error("default plan 'Plan' is required");
  await kv.put(DATA_KEY, JSON.stringify(data));
}
