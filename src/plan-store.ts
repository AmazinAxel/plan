export interface Entry { id: string; text: string; todo?: boolean }
export interface List  { id: string; name: string; entries: Entry[] }
export interface Plan  { id: string; name: string; lists: List[]; background?: string }
export interface Data  { activePlanId: string; plans: Plan[]; version: number }

const DATA_KEY = "data";

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
