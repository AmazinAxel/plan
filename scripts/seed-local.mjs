#!/usr/bin/env node
// Seed local wrangler KV with dev password "1234" and a fixed dev HMAC secret.
// Runs automatically before `npm/bun run dev`. Safe to re-run.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const PASSWORD = "1234";
const HASH = createHash("sha256").update(PASSWORD).digest("hex");
const SECRET = "dev".padEnd(64, "0"); // fixed so cookies stay valid across restarts

function put(key, value) {
  const r = spawnSync(
    "npx",
    ["wrangler", "kv", "key", "put", "--binding=PLAN_KV", "--local", key, value],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
}

put("auth:hash", HASH);
put("auth:secret", SECRET);
console.log(`[seed-local] dev password: ${PASSWORD}`);
