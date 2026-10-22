// One-off: copy the data blob and every image out of the old Cloudflare KV
// namespace into a fresh plan.db. Needs `bunx wrangler login` first.
//
//   bun scripts/import-kv.ts <kv namespace id> [out.db]
//
// Backups (`backup:*`) are not carried over: they reference images that were
// deleted when they were taken.
import { existsSync } from "node:fs";
import { openDb, putData, type Data } from "../src/plan-store";
import { isImageId } from "../src/images";

const [nsId, out = "plan.db"] = process.argv.slice(2);
if (!nsId) { console.error("usage: bun scripts/import-kv.ts <kv namespace id> [out.db]"); process.exit(1); }
if (existsSync(out)) { console.error(`${out} already exists`); process.exit(1); }

async function wrangler(...args: string[]): Promise<Uint8Array> {
  const p = Bun.spawn(["bunx", "wrangler@4", "kv", "key", ...args, "--namespace-id", nsId, "--remote"], {
    stdout: "pipe", stderr: "inherit",
  });
  const bytes = await new Response(p.stdout).bytes();
  if ((await p.exited) !== 0) throw new Error(`wrangler kv key ${args.join(" ")} failed`);
  return bytes;
}

// From the first `open` char, in case wrangler prints anything before the JSON.
const parseJson = (bytes: Uint8Array, open: string) => {
  const s = new TextDecoder().decode(bytes);
  return JSON.parse(s.slice(s.indexOf(open)));
};

// Image bytes can't be trimmed like that, so check they start with a real
// image signature instead of silently storing whatever wrangler printed.
const isImage = (b: Uint8Array) => {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  return (b[0] === 0x89 && ascii(1, 4) === "PNG") || (b[0] === 0xff && b[1] === 0xd8) ||
    ascii(0, 3) === "GIF" || (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") || ascii(4, 8) === "ftyp";
};

const keys = parseJson(await wrangler("list"), "[") as { name: string; metadata?: { ct?: string; at?: number } }[];

const data = parseJson(await wrangler("get", "data", "--text"), "{") as Data;
const db = openDb(out);
putData(db, data);
console.log(`data: ${data.plans.length} plans, version ${data.version}`);

const insert = db.query("INSERT INTO images (id, ct, at, bytes) VALUES (?, ?, ?, ?)");
const images = keys.filter((k) => k.name.startsWith("img:") && isImageId(k.name.slice(4)));
for (const [i, k] of images.entries()) {
  const bytes = await wrangler("get", k.name);
  if (!isImage(bytes)) throw new Error(`${k.name}: not image bytes (wrangler output format changed?)`);
  insert.run(k.name.slice(4), k.metadata?.ct || "application/octet-stream", k.metadata?.at ?? Date.now(), bytes);
  console.log(`image ${i + 1}/${images.length} ${k.name} (${bytes.byteLength} B)`);
}
db.close();
console.log(`wrote ${out}`);
