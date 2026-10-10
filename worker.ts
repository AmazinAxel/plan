import { buildSessionCookie, checkPassword, hasSessionCookie, verifyRequest } from "./src/auth";
import { getData, putData, isDestructive, backupData, type Data } from "./src/plan-store";
import {
  ALLOWED_TYPES, DISOWN_WINDOW_MS, MAX_IMAGE_BYTES, imageKey, imageRefs, isImageId,
  reconcile, sweep, type ImageMeta,
} from "./src/images";

interface Env {
  PLAN_KV: KVNamespace;
  ASSETS: Fetcher;
  TURNSTILE_SECRET: string;
}

// Rate limits
const RL_MAX = 3;
const RL_WINDOW_MS = 60 * 60 * 1000;

async function rateLimit(env: Env, ip: string): Promise<{ ok: boolean; retryAfter: number }> {
  const key = `rl:auth:${ip}`;
  const now = Date.now();
  const raw = await env.PLAN_KV.get(key);
  let rec = raw ? (JSON.parse(raw) as { count: number; resetAt: number }) : null;
  if (!rec || now >= rec.resetAt) rec = { count: 0, resetAt: now + RL_WINDOW_MS };
  if (rec.count >= RL_MAX) return { ok: false, retryAfter: Math.ceil((rec.resetAt - now) / 1000) };
  rec.count += 1;
  const ttl = Math.max(60, Math.ceil((rec.resetAt - now) / 1000)); // KV min TTL is 60s
  await env.PLAN_KV.put(key, JSON.stringify(rec), { expirationTtl: ttl });
  return { ok: true, retryAfter: 0 };
}

async function verifyTurnstile(token: string, secret: string, ip: string | null): Promise<boolean> {
  if (!token) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  // Unreachable or malformed counts as a failed challenge, not a 500.
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    return res.ok && ((await res.json()) as { success?: boolean }).success === true;
  } catch { return false; }
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });

// Edge-cached for an hour: it is read on every API call and page load. Rotating
// it therefore takes up to an hour to invalidate sessions in a colo that has it
// cached.
const getSecret = (env: Env) => env.PLAN_KV.get("auth:secret", { cacheTtl: 3600 });

async function handleAuth(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const [hash, secret] = await Promise.all([env.PLAN_KV.get("auth:hash"), getSecret(env)]);
  if (!hash || !secret || !env.TURNSTILE_SECRET) return json({ error: "server not initialized" }, { status: 503 });
  let body: { password?: unknown; turnstile?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad body" }, { status: 400 }); }
  if (typeof body.password !== "string") return json({ error: "bad body" }, { status: 400 });

  const ip = req.headers.get("CF-Connecting-IP");
  const token = typeof body.turnstile === "string" ? body.turnstile : "";
  if (!(await verifyTurnstile(token, env.TURNSTILE_SECRET, ip))) {
    return json({ error: "challenge failed" }, { status: 403 });
  }

  const rl = await rateLimit(env, ip || "unknown");
  if (!rl.ok) {
    return json({ error: "too many attempts" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  }

  const { ok, upgrade } = await checkPassword(body.password, hash);
  if (!ok) return json({ error: "invalid" }, { status: 401 });
  if (upgrade) await env.PLAN_KV.put("auth:hash", upgrade); // legacy SHA-256 → PBKDF2
  return new Response(null, { status: 204, headers: { "Set-Cookie": await buildSessionCookie(secret, req) } });
}

// POST /api/img                 -> store the body, return { id }
// GET|HEAD|DELETE /api/img/<id> -> fetch / probe / drop one image
async function handleImage(req: Request, env: Env, id: string): Promise<Response> {
  if (req.method === "POST") {
    if (id) return new Response(null, { status: 404 });
    const type = (req.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.has(type)) return json({ error: "unsupported type" }, { status: 415 });
    // Reject on the declared length before buffering the body into memory.
    const declared = Number(req.headers.get("Content-Length") || 0);
    if (declared > MAX_IMAGE_BYTES) return json({ error: "too large" }, { status: 413 });
    const bytes = await req.arrayBuffer();
    if (bytes.byteLength === 0) return json({ error: "empty" }, { status: 400 });
    if (bytes.byteLength > MAX_IMAGE_BYTES) return json({ error: "too large" }, { status: 413 });
    const newId = crypto.randomUUID();
    const meta: ImageMeta = { ct: type, at: Date.now() };
    await env.PLAN_KV.put(imageKey(newId), bytes, { metadata: meta });
    return json({ id: newId }, { status: 201 });
  }

  if (!isImageId(id)) return new Response(null, { status: 404 });

  // HEAD is how the client confirms a broken <img> is genuinely missing rather
  // than a dropped connection, before it drops the reference.
  if (req.method === "HEAD") {
    const { metadata } = await env.PLAN_KV.getWithMetadata<ImageMeta>(imageKey(id), "stream");
    return new Response(null, { status: metadata ? 200 : 404 });
  }

  if (req.method === "GET") {
    const { value, metadata } = await env.PLAN_KV.getWithMetadata<ImageMeta>(imageKey(id), "stream");
    if (!value) return new Response(null, { status: 404 });
    // Ids are unique per upload and an image is never rewritten, so the bytes at
    // a given URL can't change — the browser may keep them forever. That matters
    // here: render() rebuilds the whole board on every keystroke, so each repaint
    // would otherwise re-request every visible image.
    return new Response(value, {
      headers: {
        "Content-Type": metadata?.ct || "application/octet-stream",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  }

  // Only used for the narrow case of an upload whose reference never made it
  // into the blob (the entry was deleted while the bytes were still uploading).
  // Doubly guarded, because KV reads are eventually consistent and a stale read
  // of the blob could otherwise be talked into deleting a live image: the id
  // must be unreferenced *and* young enough that it can only be the caller's
  // own abandoned upload.
  if (req.method === "DELETE") {
    const { metadata } = await env.PLAN_KV.getWithMetadata<ImageMeta>(imageKey(id), "stream");
    if (!metadata) return new Response(null, { status: 204 });
    if (Date.now() - metadata.at > DISOWN_WINDOW_MS) return json({ error: "too old" }, { status: 409 });
    const data = await getData(env.PLAN_KV);
    if (imageRefs(data).has(id)) return json({ error: "referenced" }, { status: 409 });
    await env.PLAN_KV.delete(imageKey(id));
    return new Response(null, { status: 204 });
  }

  return new Response(null, { status: 405 });
}

async function requireAuth(req: Request, env: Env): Promise<boolean> {
  const secret = hasSessionCookie(req) && (await getSecret(env));
  return !!secret && verifyRequest(req, secret);
}

// Scripts only from this origin (plus Turnstile, which also needs its iframe).
// Images are open because a plan background is any URL the user pastes. Inline
// styles stay allowed for Turnstile's widget; inline *scripts* do not — the boot
// blob is a JSON data block, which the browser never executes.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src * data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// On every response the worker returns (assets it passes through included;
// assets served directly get theirs from public/_headers). API responses default
// to no-store: they carry private data and must never sit in a cache.
function harden(res: Response, path: string): Response {
  const out = new Response(res.body, res);
  const h = out.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("Strict-Transport-Security", "max-age=31536000");
  h.set("X-Frame-Options", "DENY");
  if (path.startsWith("/api/") && !h.has("Cache-Control")) h.set("Cache-Control", "no-store");
  return out;
}

const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// Served with a content version in the query (see servePage) so they can be
// cached forever: a deploy changes the version, and with it the URL.
const VERSIONED_ASSETS = new Set(["/styles.css", "/app.js"]);

// The page is assembled here rather than served as a static asset so the first
// paint needs no API round-trip: the data blob (when authed) is inlined, and
// styles.css/app.js are linked under content-versioned URLs that the browser
// caches immutably — external rather than inlined so repeat loads re-download
// nothing and reuse the browser's compiled-code cache. The client keeps the
// board hidden until it has rendered from that data, so the first painted frame
// is the final one.
async function servePage(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Plain requests: a forwarded If-None-Match could hand back a bodiless 304.
  const plain = (p: string, method = "GET") => env.ASSETS.fetch(new Request(new URL(p, req.url), { method }));
  const version = (p: string) =>
    plain(p, "HEAD").then((r) => (r.headers.get("ETag") || "").replace(/^W\/|"/g, ""));
  // With a session cookie present, the data read is started alongside the
  // secret read rather than after the auth check, so the page waits on one KV
  // round-trip, not two. Without one, KV isn't touched at all. A failed read
  // yields `undefined`, which the client answers by fetching /api/data itself.
  const session = hasSessionCookie(req);
  const [html, cssV, jsV, secret, read] = await Promise.all([
    plain("/").then((r) => r.text()), version("/styles.css"), version("/app.js"),
    session ? getSecret(env) : null,
    session ? getData(env.PLAN_KV).catch(() => undefined) : undefined,
  ]);
  const authed = !!secret && (await verifyRequest(req, secret));
  const data: Data | null | undefined = authed ? read : null;
  if (data) ctx.waitUntil(sweep(env.PLAN_KV, data));
  const versioned = (p: string, v: string) => (v ? `${p}?v=${encodeURIComponent(v)}` : p);
  const cssUrl = versioned("/styles.css", cssV);

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
  // Signed out: the auth dialog will load Turnstile, so open its connection now.
  if (data === null) preloads.push(`<link rel="preconnect" href="https://challenges.cloudflare.com"/>`);
  // `<` escaped so nothing in an entry's text can close the script element.
  const boot = data === undefined ? "" :
    `<script id="boot" type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;

  const res = new HTMLRewriter()
    .on("head", { element: (el) => { el.append(preloads.join(""), { html: true }); } })
    .on('link[rel="stylesheet"]', { element: (el) => { el.setAttribute("href", cssUrl); } })
    .on('script[type="module"]', {
      element: (el) => { el.setAttribute("src", versioned("/app.js", jsV)); el.before(boot, { html: true }); },
    })
    .transform(new Response(html));
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": CSP,
    // Cloudflare replays these as a 103 Early Hints (when enabled on the zone),
    // so the critical files start downloading while the worker is still
    // reading KV.
    Link: [
      `<${cssUrl}>; rel=preload; as=style`,
      "</fonts/sora-latin.woff2>; rel=preload; as=font; type=font/woff2; crossorigin",
      "</fonts/hammersmith-one-latin.woff2>; rel=preload; as=font; type=font/woff2; crossorigin",
    ].join(", "),
  });
  // Re-issued on every authed load, so the cookie's 400-day lifetime only runs
  // out on a device that hasn't opened the app in that long.
  if (authed) headers.set("Set-Cookie", await buildSessionCookie(secret!, req));
  return new Response(res.body, { headers });
}

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/" && (req.method === "GET" || req.method === "HEAD")) return servePage(req, env, ctx);

  if (VERSIONED_ASSETS.has(path) && url.searchParams.has("v")) {
    const res = await env.ASSETS.fetch(req);
    if (!res.ok) return res;
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return out;
  }

  if (path === "/api/auth") return handleAuth(req, env);

  if (path.startsWith("/api/")) {
    if (!(await requireAuth(req, env))) return new Response(null, { status: 401 });

    if (path === "/api/img" || path.startsWith("/api/img/")) {
      return handleImage(req, env, path.slice("/api/img/".length));
    }

    if (path === "/api/data") {
      if (req.method === "GET") {
        const data = await getData(env.PLAN_KV);
        // Collect anything the PUT-time diff couldn't see (an upload whose
        // save never landed). Throttled internally; runs after the response.
        ctx.waitUntil(sweep(env.PLAN_KV, data));
        return json(data);
      }
      if (req.method === "PUT") {
        let body: Data;
        try { body = await req.json(); } catch { return json({ error: "bad body" }, { status: 400 }); }
        // Optimistic concurrency: a write declares the version it was based on;
        // if that's stale, another device wrote first, so reject with 409 + the
        // current data instead of clobbering it.
        const current = await getData(env.PLAN_KV);
        const expected = req.headers.get("X-Plan-Version");
        if (expected !== null && expected !== String(current.version)) {
          return json(current, { status: 409, headers: { "X-Plan-Version": String(current.version) } });
        }
        const next = { ...body, version: current.version + 1 };
        // Snapshot the state being replaced when this write deletes a plan or
        // list, so it can be rolled back from the Cloudflare KV dashboard.
        if (isDestructive(current, next)) await backupData(env.PLAN_KV, current);
        try { await putData(env.PLAN_KV, next); } catch (e) {
          return json({ error: (e as Error).message }, { status: 400 });
        }
        // Strictly after the blob is committed: any image this write drops is
        // now unreachable, and deleting before the commit would risk leaving a
        // live reference pointing at deleted bytes.
        ctx.waitUntil(reconcile(env.PLAN_KV, current, next));
        return new Response(null, { status: 204, headers: { "X-Plan-Version": String(next.version) } });
      }
      return new Response(null, { status: 405 });
    }

    return new Response(null, { status: 404 });
  }

  return env.ASSETS.fetch(req);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return harden(await route(req, env, ctx), new URL(req.url).pathname);
  },
};
