# Plan

Focused and highly optimized planning app

## Drop it on Cloudflare for free!

```sh
bunx wrangler login
bunx wrangler kv namespace create PLAN_KV
```

Copy `id` into `wrangler.jsonc` under `kv_namespaces[0].id`

```sh
node -e 'crypto.subtle.digest("SHA-256", new TextEncoder().encode(process.argv[1])).then(b => console.log([...new Uint8Array(b)].map(x => x.toString(16).padStart(2,"0")).join("")))' 'YOUR_PASSWORD_HERE!!!!!!'
bunx wrangler kv key put --binding=PLAN_KV --remote auth:hash 'PASTE_HASH'
node -e 'console.log(crypto.randomBytes(32).toString("hex"))'
bunx wrangler kv key put --binding=PLAN_KV --remote auth:secret 'PASTE_SECRET'
bunx wrangler secret put TURNSTILE_SECRET
bun run deploy
```

(app created with the help of Claude Code)
