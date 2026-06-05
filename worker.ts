import { buildSessionCookie, checkPassword, verifyRequest } from "./src/auth";
import { getData, putData, type Data } from "./src/plan-store";

interface Env {
  PLAN_KV: KVNamespace;
  ASSETS: Fetcher;
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
  if (!hash || !secret) return json({ error: "server not initialized" }, { status: 503 });
  let body: { password?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad body" }, { status: 400 }); }
  if (typeof body.password !== "string") return json({ error: "bad body" }, { status: 400 });
  if (!(await checkPassword(body.password, hash))) {
    return json({ error: "invalid" }, { status: 401 });
  }
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": await buildSessionCookie(secret) },
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
