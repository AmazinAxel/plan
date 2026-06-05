# plan

todo wallpapers

beta app made w/ Claude

---

## Local dev

```sh
bun install        # or npm install
bun run dev        # password is "1234"
```

`predev` runs `scripts/seed-local.mjs`, which writes `auth:hash` (sha256 of `1234`) and a fixed dev `auth:secret` into the local Miniflare KV. Safe to re-run; cookies persist across restarts.

To change the local password, edit `PASSWORD` in `scripts/seed-local.mjs`.

## Deploy to Cloudflare

1. **Log in** (once per machine):
   ```sh
   bunx wrangler login
   ```

2. **Create the KV namespace** (once per project):
   ```sh
   bunx wrangler kv namespace create PLAN_KV
   ```
   Copy the printed `id` into `wrangler.jsonc` under `kv_namespaces[0].id`, replacing the existing one.

3. **Seed the production password hash and cookie secret:**
   ```sh
   # 1. hash your real password
   node -e 'crypto.subtle.digest("SHA-256", new TextEncoder().encode(process.argv[1])).then(b => console.log([...new Uint8Array(b)].map(x => x.toString(16).padStart(2,"0")).join("")))' 'YOUR_REAL_PASSWORD'

   bunx wrangler kv key put --binding=PLAN_KV --remote auth:hash 'PASTE_HASH'

   # 2. generate a random 32-byte secret
   node -e 'console.log(crypto.randomBytes(32).toString("hex"))'

   bunx wrangler kv key put --binding=PLAN_KV --remote auth:secret 'PASTE_SECRET'
   ```

4. **Deploy:**
   ```sh
   bun run deploy
   ```
   The first deploy prints the `*.workers.dev` URL. Open it; the password dialog should appear.

To rotate the password or invalidate every existing session, overwrite the corresponding key with step 3 again.

## Scripts

| Script             | Purpose                                |
|--------------------|----------------------------------------|
| `bun run dev`      | Local Wrangler dev (seeds local KV)    |
| `bun run deploy`   | Publish to Cloudflare                  |
| `bun run typecheck`| `tsc --noEmit`                         |

## Files

| Path                            | What                                                  |
|---------------------------------|-------------------------------------------------------|
| `worker.ts`                     | Workers entry: route dispatch + auth middleware       |
| `src/auth.ts`                   | Cookie sign/verify (HMAC-SHA256), password check      |
| `src/plan-store.ts`             | KV read/write of the single `data` blob               |
| `public/index.html`             | App shell + dialogs                                   |
| `public/styles.css`             | Nord palette and base layout — style freely           |
| `public/app.js`                 | All client logic: state, render, keyboard, touch, drag |
| `public/vendor/sortable.min.js` | SortableJS (vendored)                                 |
| `AGENTS.md`                     | Operating manual for future Claude sessions           |

## API

| Method | Path        | Notes                                              |
|--------|-------------|----------------------------------------------------|
| POST   | `/api/auth` | `{ password }` → 204 + `Set-Cookie session=…`      |
| GET    | `/api/me`   | 204 if authed, 401 otherwise                       |
| GET    | `/api/data` | The full `Data` blob                               |
| PUT    | `/api/data` | Replace the full `Data` blob                       |

All non-`/api/*` paths are served from `public/` by the `ASSETS` binding.
