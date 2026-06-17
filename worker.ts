import { buildSessionCookie, checkPassword, verifyRequest } from "./src/auth";
import { getData, putData, type Data } from "./src/plan-store";

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

async function getSecret(env: Env): Promise<string | null> {
  return env.PLAN_KV.get("auth:secret");
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

async function requireAuth(req: Request, env: Env): Promise<boolean> {
  const secret = await getSecret(env);
  if (!secret) return false;
  return verifyRequest(req, secret);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/auth") return handleAuth(req, env);

    if (path.startsWith("/api/")) {
      if (!(await requireAuth(req, env))) return new Response(null, { status: 401 });

      if (path === "/api/me") return new Response(null, { status: 204 });

      if (path === "/api/data") {
        if (req.method === "GET") return json(await getData(env.PLAN_KV));
        if (req.method === "PUT") {
          let body: Data;
          try { body = await req.json(); } catch { return json({ error: "bad body" }, { status: 400 }); }
          try { await putData(env.PLAN_KV, body); } catch (e) {
            return json({ error: (e as Error).message }, { status: 400 });
          }
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 405 });
      }

      return new Response(null, { status: 404 });
    }

    return env.ASSETS.fetch(req);
  },
};
