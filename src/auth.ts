const enc = new TextEncoder();

const toHex = (buf: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) => new Uint8Array(hex.match(/.{2}/g)!.map(h => parseInt(h, 16)));

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secretHex: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", fromHex(secretHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

// ---------- password ----------
// Stored as `pbkdf2$<iterations>$<salt hex>$<hash hex>`. 100k is the most
// iterations the Workers runtime allows. A bare SHA-256 hex digest (the format
// the README's setup command produces) is still accepted, and checkPassword
// hands back a PBKDF2 replacement for it on the first successful login.
const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2Hex(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return toHex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${await pbkdf2Hex(password, salt, PBKDF2_ITERATIONS)}`;
}

export async function checkPassword(password: string, stored: string): Promise<{ ok: boolean; upgrade?: string }> {
  const [scheme, iter, salt, hash] = stored.split("$");
  if (scheme === "pbkdf2") {
    return { ok: constantTimeEqual(await pbkdf2Hex(password, fromHex(salt), Number(iter)), hash) };
  }
  const ok = constantTimeEqual(toHex(await crypto.subtle.digest("SHA-256", enc.encode(password))), stored);
  return ok ? { ok, upgrade: await hashPassword(password) } : { ok };
}

// ---------- session ----------
// The token is the same for every session, so it carries no state and costs no
// KV lookup; rotating `auth:secret` is what logs every device out.
const COOKIE_NAME = "session";
const SESSION_PAYLOAD = "v1";
// Browsers cap cookie lifetime at 400 days; servePage re-issues the cookie on
// every authed page load, so a device in use never reaches it.
const MAX_AGE = 400 * 24 * 60 * 60;

// `Secure` only over https, so a plain-http `wrangler dev` can still sign in.
export async function buildSessionCookie(secretHex: string, req: Request): Promise<string> {
  const secure = new URL(req.url).protocol === "https:" ? "Secure; " : "";
  const token = await hmacHex(secretHex, SESSION_PAYLOAD);
  return `${COOKIE_NAME}=${token}; HttpOnly; ${secure}SameSite=Strict; Path=/; Max-Age=${MAX_AGE}`;
}

const readSession = (req: Request) =>
  req.headers.get("Cookie")?.match(/(?:^|;\s*)session=([^;]*)/)?.[1] ?? null;

// Cheap pre-check, so a request with no session at all is turned away without
// spending a KV read on the secret.
export const hasSessionCookie = (req: Request) => readSession(req) !== null;

export async function verifyRequest(req: Request, secretHex: string): Promise<boolean> {
  const token = readSession(req);
  return !!token && constantTimeEqual(token, await hmacHex(secretHex, SESSION_PAYLOAD));
}
