import { buildSessionCookie, checkPassword, verifyRequest } from "./src/auth";
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

function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") || "unknown";
}

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

async function verifyTurnstile(token: string, secret: string, ip: string): Promise<boolean> {
  if (!token) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip && ip !== "unknown") form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { success?: boolean };
  return data.success === true;
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });

// Edge-cached for an hour: it is read on every API call and page load. Rotating
// it therefore takes up to an hour to invalidate sessions in a colo that has it
// cached.
async function getSecret(env: Env): Promise<string | null> {
  return env.PLAN_KV.get("auth:secret", { cacheTtl: 3600 });
}

async function getHash(env: Env): Promise<string | null> {
  return env.PLAN_KV.get("auth:hash");
}

async function handleAuth(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const [hash, secret] = await Promise.all([getHash(env), getSecret(env)]);
  if (!hash || !secret || !env.TURNSTILE_SECRET) return json({ error: "server not initialized" }, { status: 503 });
  let body: { password?: unknown; turnstile?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad body" }, { status: 400 }); }
  if (typeof body.password !== "string") return json({ error: "bad body" }, { status: 400 });

  const ip = clientIp(req);

  const token = typeof body.turnstile === "string" ? body.turnstile : "";
  if (!(await verifyTurnstile(token, env.TURNSTILE_SECRET, ip))) {
    return json({ error: "challenge failed" }, { status: 403 });
  }

  const rl = await rateLimit(env, ip);
  if (!rl.ok) {
    return json({ error: "too many attempts" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  }

  if (!(await checkPassword(body.password, hash))) {
    return json({ error: "invalid" }, { status: 401 });
  }
  const secure = new URL(req.url).protocol === "https:";
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": await buildSessionCookie(secret, secure) },
  });
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
  const secret = await getSecret(env);
  if (!secret) return false;
  return verifyRequest(req, secret);
}

const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// The page is assembled here rather than served as a static asset so the first
// paint costs one round-trip: the stylesheet, app.js and (when authed) the data
// blob are inlined, and the active plan's images are preloaded while the rest of
// the HTML parses. The client keeps the board hidden until it has rendered from
// that data, so the first painted frame is the final one.
async function servePage(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Plain requests: a forwarded If-None-Match could hand back a bodiless 304.
  const asset = (p: string) => env.ASSETS.fetch(new Request(new URL(p, req.url))).then((r) => r.text());
  const [html, css, js, data] = await Promise.all([
    asset("/"), asset("/styles.css"), asset("/app.js"),
    requireAuth(req, env).then((ok) => (ok ? getData(env.PLAN_KV) : null)),
  ]);
  if (data) ctx.waitUntil(sweep(env.PLAN_KV, data));

  const plan = data && (data.plans.find((p) => p.id === data.activePlanId) || data.plans[0]);
  const preloads: string[] = [];
  if (plan?.background) preloads.push(`<link rel="preload" as="image" href="${escapeAttr(plan.background)}"/>`);
  for (const id of plan ? imageRefs({ ...data!, plans: [plan] }) : []) {
    if (!isImageId(id)) continue;
    preloads.push(`<link rel="preload" as="image" href="/api/img/${id}"/>`);
  }
  // `<` escaped so nothing in an entry's text can close the script element.
  const boot = JSON.stringify(data).replace(/</g, "\\u003c");

  const res = new HTMLRewriter()
    .on("head", { element: (el) => { el.append(preloads.join(""), { html: true }); } })
    .on('link[rel="stylesheet"]', { element: (el) => { el.replace(`<style>${css}</style>`, { html: true }); } })
    .on('script[type="module"]', {
      element: (el) => {
        el.replace(`<script id="boot" type="application/json">${boot}</script><script type="module">${js}</script>`, { html: true });
      },
    })
    .transform(new Response(html));
  return new Response(res.body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // Cloudflare replays these as a 103 Early Hints (when enabled on the zone),
      // so the fonts start downloading while the worker is still reading KV.
      Link: [
        "</fonts/sora-latin.woff2>; rel=preload; as=font; type=font/woff2; crossorigin",
        "</fonts/hammersmith-one-latin.woff2>; rel=preload; as=font; type=font/woff2; crossorigin"
      ].join(", "),
    },
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/" && (req.method === "GET" || req.method === "HEAD")) return servePage(req, env, ctx);

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
  },
};
