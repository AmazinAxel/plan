// The whole backend: a Bun HTTP server over one SQLite file. Meant to sit
// behind `tailscale serve` (see nix/module.nix), which terminates HTTPS and
// limits access to the tailnet, so there is no auth here at all — bind it to
// anything but localhost and anyone who can reach the port has the data.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getData, putData, isDestructive, backupData, openDb, type Data } from "./src/plan-store";
import {
  ALLOWED_TYPES, DISOWN_WINDOW_MS, MAX_IMAGE_BYTES, SWEEP_INTERVAL_MS, deleteImage, getImage,
  imageMeta, imageRefs, isImageId, putImage, reconcile, sweep,
} from "./src/images";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = resolve(process.env.PLAN_DATA_DIR || "data");
const DIST = resolve(process.env.PLAN_DIST || join(import.meta.dir, "dist"));

mkdirSync(DATA_DIR, { recursive: true });
const db = openDb(join(DATA_DIR, "plan.db"));

// Collect anything the PUT-time diff couldn't see (an upload whose save never
// landed).
const runSweep = () => { try { sweep(db, getData(db)); } catch (e) { console.error("sweep", e); } };
runSweep();
setInterval(runSweep, SWEEP_INTERVAL_MS);

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });

// POST /api/img                 -> store the body, return { id }
// GET|HEAD|DELETE /api/img/<id> -> fetch / probe / drop one image
async function handleImage(req: Request, id: string): Promise<Response> {
  if (req.method === "POST") {
    if (id) return new Response(null, { status: 404 });
    const type = (req.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.has(type)) return json({ error: "unsupported type" }, { status: 415 });
    // Reject on the declared length before buffering the body into memory.
    const declared = Number(req.headers.get("Content-Length") || 0);
    if (declared > MAX_IMAGE_BYTES) return json({ error: "too large" }, { status: 413 });
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength === 0) return json({ error: "empty" }, { status: 400 });
    if (bytes.byteLength > MAX_IMAGE_BYTES) return json({ error: "too large" }, { status: 413 });
    const newId = crypto.randomUUID();
    putImage(db, newId, type, bytes);
    return json({ id: newId }, { status: 201 });
  }

  if (!isImageId(id)) return new Response(null, { status: 404 });

  // HEAD is how the client confirms a broken <img> is genuinely missing rather
  // than a dropped connection, before it drops the reference.
  if (req.method === "HEAD") return new Response(null, { status: imageMeta(db, id) ? 200 : 404 });

  if (req.method === "GET") {
    const img = getImage(db, id);
    if (!img) return new Response(null, { status: 404 });
    // Ids are unique per upload and an image is never rewritten, so the bytes at
    // a given URL can't change — the browser may keep them forever. That matters
    // here: render() rebuilds the whole board on every keystroke, so each repaint
    // would otherwise re-request every visible image.
    return new Response(img.bytes, {
      headers: { "Content-Type": img.ct, "Cache-Control": "private, max-age=31536000, immutable" },
    });
  }

  // Only used for the narrow case of an upload whose reference never made it
  // into the blob (the entry was deleted while the bytes were still uploading).
  // The id must be unreferenced *and* young enough that it can only be the
  // caller's own abandoned upload.
  if (req.method === "DELETE") {
    const meta = imageMeta(db, id);
    if (!meta) return new Response(null, { status: 204 });
    if (Date.now() - meta.at > DISOWN_WINDOW_MS) return json({ error: "too old" }, { status: 409 });
    if (imageRefs(getData(db)).has(id)) return json({ error: "referenced" }, { status: 409 });
    deleteImage(db, id);
    return new Response(null, { status: 204 });
  }

  return new Response(null, { status: 405 });
}

// PUT /api/data as one transaction: the version check, the backup, the write
// and the deletion of the images it drops all commit together.
const saveData = db.transaction((body: Data, expected: string | null): Response => {
  // Optimistic concurrency: a write declares the version it was based on; if
  // that's stale, another device wrote first, so reject with 409 + the current
  // data instead of clobbering it.
  const current = getData(db);
  if (expected !== null && expected !== String(current.version)) {
    return json(current, { status: 409, headers: { "X-Plan-Version": String(current.version) } });
  }
  const next = { ...body, version: current.version + 1 };
  // Snapshot the state being replaced when this write deletes a plan or list.
  if (isDestructive(current, next)) backupData(db, current);
  putData(db, next);
  reconcile(db, current, next);
  return new Response(null, { status: 204, headers: { "X-Plan-Version": String(next.version) } });
});

// Scripts only from this origin. Images are open because a plan background is
// any URL the user pastes. Inline *scripts* are not allowed — the boot blob is
// a JSON data block, which the browser never executes.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src * data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// On every response. API responses default to no-store: they carry private data
// and must never sit in a cache.
function harden(res: Response, path: string): Response {
  const h = res.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("Strict-Transport-Security", "max-age=31536000");
  if (path.startsWith("/api/") && !h.has("Cache-Control")) h.set("Cache-Control", "no-store");
  return res;
}

const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// Served with a content version in the query (see servePage) so they can be
// cached forever: a new build changes the version, and with it the URL.
const VERSIONED_ASSETS = new Set(["/styles.css", "/app.js"]);

// Vendored and never edited in place (a replacement gets a new filename), so
// repeat loads skip revalidation.
const cacheControl = (path: string) =>
  path.startsWith("/fonts/") || path === "/Sortable.min.js" ? "public, max-age=31536000, immutable"
  : path === "/planning.png" ? "public, max-age=86400, stale-while-revalidate=604800"
  : "no-cache";

// dist/ only changes with a new build, which restarts the server, so the shell
// and the asset versions are read once at startup.
const version = async (p: string) => Bun.hash(await Bun.file(join(DIST, p)).arrayBuffer()).toString(36);
const shell = await Bun.file(join(DIST, "index.html")).text();
const cssUrl = `/styles.css?v=${await version("styles.css")}`;
const jsUrl = `/app.js?v=${await version("app.js")}`;

// The page is assembled here rather than served as a static asset so the first
// paint needs no API round-trip: the data blob is inlined, and styles.css/app.js
// are linked under content-versioned URLs that the browser caches immutably —
// external rather than inlined so repeat loads re-download nothing and reuse the
// browser's compiled-code cache. The client keeps the board hidden until it has
// rendered from that data, so the first painted frame is the final one.
function servePage(): Response {
  // A failed read yields `undefined`, which the client answers by fetching
  // /api/data itself.
  let data: Data | undefined;
  try { data = getData(db); } catch (e) { console.error("read", e); }

  const plan = data && (data.plans.find((p) => p.id === data.activePlanId) || data.plans[0]);
  const preloads: string[] = [];
  if (plan?.background) preloads.push(`<link rel="preload" as="image" href="${escapeAttr(plan.background)}"/>`);
  // Only images without a recorded size: those are what reveal() waits on. A
  // sized one has its box reserved, so it can arrive late without shifting
  // anything, and preloading it would only take bandwidth from the fonts.
  for (const list of plan?.lists ?? []) {
    for (const e of list.entries ?? []) {
      if (e.image && !e.imageSize && isImageId(e.image)) {
        preloads.push(`<link rel="preload" as="image" href="/api/img/${e.image}"/>`);
      }
    }
  }
  // `<` escaped so nothing in an entry's text can close the script element.
  const boot = data === undefined ? "" :
    `<script id="boot" type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;

  const res = new HTMLRewriter()
    .on("head", { element: (el) => { el.append(preloads.join(""), { html: true }); } })
    .on('link[rel="stylesheet"]', { element: (el) => { el.setAttribute("href", cssUrl); } })
    .on('script[type="module"]', {
      element: (el) => { el.setAttribute("src", jsUrl); el.before(boot, { html: true }); },
    })
    .transform(new Response(shell));
  return new Response(res.body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": CSP,
      Link: [
        `<${cssUrl}>; rel=preload; as=style`,
        "</fonts/sora-latin.woff2>; rel=preload; as=font; type=font/woff2; crossorigin",
        "</fonts/hammersmith-one-latin.woff2>; rel=preload; as=font; type=font/woff2; crossorigin",
      ].join(", "),
    },
  });
}

async function serveAsset(req: Request, path: string, versioned: boolean): Promise<Response> {
  const file = resolve(DIST, "." + path);
  if (!file.startsWith(DIST + "/")) return new Response(null, { status: 404 });
  const f = Bun.file(file);
  if (!(await f.exists())) return new Response(null, { status: 404 });
  return new Response(req.method === "HEAD" ? null : f, {
    headers: {
      "Content-Type": f.type,
      "Cache-Control": versioned ? "public, max-age=31536000, immutable" : cacheControl(path),
    },
  });
}

async function route(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;

  if (path === "/" && (req.method === "GET" || req.method === "HEAD")) return servePage();

  if (path === "/api/img" || path.startsWith("/api/img/")) {
    return handleImage(req, path.slice("/api/img/".length));
  }

  if (path === "/api/data") {
    if (req.method === "GET") return json(getData(db));
    if (req.method === "PUT") {
      let body: Data;
      try { body = (await req.json()) as Data; } catch { return json({ error: "bad body" }, { status: 400 }); }
      try { return saveData(body, req.headers.get("X-Plan-Version")); } catch (e) {
        return json({ error: (e as Error).message }, { status: 400 });
      }
    }
    return new Response(null, { status: 405 });
  }

  if (path.startsWith("/api/")) return new Response(null, { status: 404 });

  if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405 });
  return serveAsset(req, path, VERSIONED_ASSETS.has(path) && url.searchParams.has("v"));
}

Bun.serve({
  hostname: HOST,
  port: PORT,
  maxRequestBodySize: MAX_IMAGE_BYTES + 1024 * 1024,
  async fetch(req) {
    const url = new URL(req.url);
    return harden(await route(req, url), url.pathname);
  },
  error(e) {
    console.error(e);
    return new Response(null, { status: 500 });
  },
});
console.log(`plan listening on http://${HOST}:${PORT}, data in ${DATA_DIR}`);
