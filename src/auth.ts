const enc = new TextEncoder();

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secretHex: string, message: string): Promise<string> {
  const keyBytes = new Uint8Array(secretHex.match(/.{2}/g)!.map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const COOKIE_NAME = "session";
const SESSION_PAYLOAD = "v1";

export async function buildSessionCookie(secretHex: string): Promise<string> {
  const token = await hmacHex(secretHex, SESSION_PAYLOAD);
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000000`;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export async function verifyRequest(req: Request, secretHex: string): Promise<boolean> {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return false;
  const expected = await hmacHex(secretHex, SESSION_PAYLOAD);
  return constantTimeEqual(token, expected);
}

export async function checkPassword(password: string, expectedHashHex: string): Promise<boolean> {
  const actual = await sha256Hex(password);
  return constantTimeEqual(actual, expectedHashHex);
}
