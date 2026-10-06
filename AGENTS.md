# AGENTS — operating manual

Read this first. The README has setup; this file has the design.

## Stack

Cloudflare Workers (`worker.ts`) + a KV namespace bound as `PLAN_KV` (data blob *and* entry images) + a static `ASSETS` binding pointing at `public/`. No bundler, no framework. The browser loads `public/index.html`, which imports `public/app.js` as a module and loads the vendored `public/Sortable.min.js` `async` (drag attaches once it arrives, so it never delays first paint).

When changing bindings, update the hand-written `Env` interface in `worker.ts`, then `bun run typecheck`. Tooling is bun (`bun.lock`); run wrangler as `bunx wrangler`.

## Data model

```ts
type Entry = { id: string; text: string; todo?: boolean; image?: string; imageSize?: [number, number] };
type List  = { id: string; name: string; entries: Entry[] };
type Plan  = { id: string; name: string; lists: List[]; background?: string };
type Data  = { activePlanId: string; plans: Plan[]; version: number };
```

Stored as a single JSON blob at KV key `data`. `src/plan-store.ts` is the only thing that touches it. The plan named exactly `Plan` is special: enforced to exist by `putData`, and the client refuses to delete it.

## Images (`src/images.ts`)

One optional image per entry. `Entry.image` holds a uuid; the bytes live in the **same KV namespace** at `img:<uuid>`, with content type and upload time in the key's metadata. Bytes never go in the data blob — it is re-PUT in full on every save.

R2 is the natural home for this and the code was first written against it, but enabling R2 requires a billing subscription on the account even at zero cost. KV needs none, and its 25 MB value ceiling is far above the 10 MB cap here. The price is **eventual consistency**, which is what most of the care below is about. Note the shared namespace: `isImageId` gates every id against a uuid regex so a crafted request can't address `auth:secret`.

**No orphans, ever.** That invariant is enforced on the server, because every interesting failure (undo, a lost 409, a closed tab mid-upload) is one the client can't be trusted to report:

1. **`reconcile` on every `PUT /api/data`** — deletes `refs(current) \ refs(next)`. Every way an image stops being referenced (detach, entry/list/plan delete, undo, overwriting an entry's image) arrives as one blob replacing another, so the set difference catches all of them. Runs *after* `putData` commits: deleting first would risk a live reference to deleted bytes, which is worse than an orphan.
2. **`sweep` on `GET /api/data`** — the backstop for ids that never reached any blob (upload succeeded, then the tab closed or the save lost a 409), which no diff can see. Throttled to one list per 10 min via `sweep:at`, and skips keys whose metadata `at` is under 24 h old. That grace is deliberately generous: an image is unreferenced from upload until its save lands, a gap that stretches indefinitely if the client goes offline holding a pending write. Collecting a rare abandoned upload a day late costs nothing; collecting one whose reference was merely in transit is unrecoverable.

There is deliberately **no "does this id exist?" check before committing a reference**. An earlier draft had one; under KV it is actively harmful, since a freshly uploaded id can read as missing and the check would strip the reference to an image that does exist. The client only ever sets a reference after a 201, and `healBrokenImage` handles the genuinely-missing case.

The client's job is to keep references honest, and to never act on a stale read:

- `scrubHistory()` (called from `save`/`saveNow`) strips from every undo snapshot any image id the live data no longer references, and prunes `imgCache`/`objectUrls` on the same pass. Without it, Ctrl+Z after a delete would restore a reference to bytes the server has already destroyed. **Consequence: removing an image is not undoable** — undo brings the entry back without its picture.
- `flushSave()` keeps entries that have an image when stripping blank ones. Dropping one would hide its reference from the server, whose diff would then delete an image still on screen.
- `objectUrls` holds a blob URL for every image uploaded this session and `imgSrc()` prefers it over the network. A read straight after a write can 404, and that miss can stay cached in the colo for up to a minute; rendering from the bytes already in hand skips the window entirely.
- `healBrokenImage()` drops a reference on a **confirmed 404 only** (verified with a HEAD), and never for an id in `objectUrls` — we uploaded it, so a 404 there is a stale read, not a missing image. The same `error` event also fires for a dropped connection, and discarding a live image over one lost packet can't be undone.
- `refresh()` and the 409 branch of `flushSave()` both adopt a remote blob only when its version is **strictly newer**. A stale read handing back the blob we just replaced would roll our own edits back, and an image reference lost that way gets its bytes deleted by the next write's diff. A 409 measured against a stale read isn't a real conflict, so the write stays pending and retries instead.
- An upload that finishes after its entry was deleted `DELETE`s its own image. That route refuses any id the live blob references *and* any id older than an hour, so a stale blob read can't be used to talk it into deleting an established image.
- `imgCache` reuses one `<img>` element per id across renders, so the full-board repaint doesn't flash every picture. Responses are `immutable`-cached, since an id's bytes never change.

Pasting re-encodes through a canvas to max 1600px WebP (`encodeImage`), keeping whichever of the original/re-encode is smaller, and passing GIFs through untouched so animation survives. Server caps at 10 MB and accepts webp/png/jpeg/gif/avif.

`Entry.imageSize` is the natural `[w, h]`, recorded at upload (and backfilled on first load for older images). `.entry img.sized` reserves the box from it, so images never shift layout and the first-paint reveal does not wait on them. Cleared alongside `image` everywhere.

An entry with an image but no text is legal — clearing the field leaves the picture rather than silently destroying it. Deleting the image from a text-less entry removes the entry.

KV free tier is the operating budget: 1 GB stored, 1k writes/day, 100k reads/day. At ~200 KB per re-encoded image that is thousands of images, and one paste is one write.

⚠️ The `backup:` snapshots that `isDestructive` writes reference images that `reconcile` deletes on that same write. Restoring a week-old backup from the dashboard will therefore bring back entries whose images are gone; `healBrokenImage` clears those references on first paint. Zero orphans was the explicit requirement and this is its cost.

## Auth

- `auth:hash` in KV = `pbkdf2$<iterations>$<salt hex>$<hash hex>` (PBKDF2-SHA256, 100k iterations — the Workers ceiling). A bare SHA-256 hex digest, which is what the README's setup command writes, is also accepted and is replaced by a PBKDF2 hash on the first successful login.
- `auth:secret` in KV = 32-byte hex HMAC key.
- Cookie: `session=<HMAC-SHA256("v1", secret)>`, HttpOnly, Secure, SameSite=Strict, Max-Age 400 days (the browser cap). `servePage` re-issues it on every authed page load, so it only expires on a device unused for 400 days.
- Cookie carries no per-user state. Rotating `auth:secret` logs out every device — within an hour, since the secret read is edge-cached (`cacheTtl: 3600`). A request with no `session` cookie is rejected before any KV read; otherwise the secret is the only read auth costs.
- Constant-time compare for both password hash and cookie token.
- **Session lost mid-use** (a 401 from a save, `refresh()` or an upload): the auth dialog opens over the board and, once signed in, resumes what was cut off (`showAuth(onAuthed)`) — a failed save stays pending and is retried, so no edit is lost. The dialog can't be dismissed with Esc.
- **Headers** (`harden()` in `worker.ts`, `public/_headers` for directly-served assets): a CSP on the page (scripts from self + Turnstile only, `frame-ancestors 'none'`), `nosniff`, `Referrer-Policy: no-referrer`, HSTS, `X-Frame-Options: DENY`. Every `/api/` response without its own `Cache-Control` gets `no-store`. A new third-party script or frame needs adding to `CSP`.
- **Turnstile** gates `/api/auth`: the client sends the widget token alongside the password; the worker verifies it via `challenges.cloudflare.com/turnstile/v0/siteverify` (secret in `TURNSTILE_SECRET` — a Worker secret, set with `bunx wrangler secret put TURNSTILE_SECRET`) before looking at the password; an unreachable siteverify counts as a failed challenge. Site key (public) lives in `index.html`'s `.cf-turnstile[data-sitekey]`. The frontend resets the widget on any failure since tokens are single-use.
- **Rate limit**: `/api/auth` allows `RL_MAX` (3) attempts per IP per hour (fixed window in KV at `rl:auth:<ip>` = `{count, resetAt}`, keyed on `CF-Connecting-IP`). Order is Turnstile → rate-limit increment → password, so only valid-token submissions spend an attempt. Exceeding returns `429` with `Retry-After`.

## API

| Method | Path        | Behavior                                              |
|--------|-------------|-------------------------------------------------------|
| POST   | `/api/auth` | Verify Turnstile, rate-limit, check password, set cookie (403 bad challenge / 429 too many) |
| GET    | `/api/data` | Return full blob (seeds on first read if missing); triggers the throttled image sweep |
| PUT    | `/api/data` | Replace full blob; enforces `Plan` plan exists; then deletes newly-unreferenced images |
| POST   | `/api/img`  | Store an image body (≤10 MB, image types only) → `{ id }` |
| GET/HEAD | `/api/img/<id>` | Fetch one image, immutably cached (HEAD = existence probe) |
| DELETE | `/api/img/<id>` | Drop one object; **409 if the live blob references it** |

`GET /` is assembled by the worker (`servePage`, routed there by `run_worker_first`): the data blob is inlined as `<script id="boot" type="application/json">` (`null` when unauthed, absent if the KV read failed — the client then fetches `/api/data`), the auth check and data read run in parallel, and `styles.css`/`app.js` are linked as `?v=<asset ETag>` which the worker serves `immutable` — repeat loads download nothing and reuse the browser's compiled-code cache. Unsized images of the active plan and its background are preloaded; signed out, Turnstile is preconnected. A `Link` header feeds Cloudflare Early Hints. The response is `no-store` (it carries private data). The client keeps `body` children `visibility: hidden` until `reveal()` (first render done, fonts loaded, unsized images decoded, capped at 1.5s), so the first painted frame is the final layout. Everything else falls through to `env.ASSETS.fetch(req)`. `public/_headers` marks fonts and `Sortable.min.js` `immutable` for a year: **rename the file** when replacing one, or browsers keep the old copy.

## Client architecture (`public/app.js`)

Four concerns, in this order in the file:

1. **State + persistence** — `state.data` mirrors the server. `save()` throttles to one PUT per `SAVE_INTERVAL` (5s); `saveNow()` flushes immediately, used for destructive actions (deletes, undo, images, background).
2. **Render** — one `render()` rebuilds `<main>` from scratch each call. The data set is tiny; do not optimize prematurely.
3. **Modes** — `body.dataset.mode` is `"normal" | "insert" | "palette" | "confirm" | "image"` (the new-plan and background dialogs reuse `palette`). The desktop keyboard handler is a no-op in any non-`normal` mode.
   - **Undo** — `pushHistory()` deep-clones `state.data` + `selection` onto a 5-deep stack right before each mutating action; `undo()` (Ctrl+Z, normal mode only) pops and restores. Restored snapshots keep the live `state.data.version` so the next save doesn't 409. Abandoned creations (a new entry/list created then cancelled) call `popHistory()` to discard their snapshot, so undo never replays a no-op. `applyRemote()` clears the stack — its snapshots are relative to the superseded blob.
4. **Drag** — SortableJS, two groups (`"lists"` horizontal, `"entries"` for items). Cross-list moves work in single view too: a drag starting there flips the board to multi view for its duration (`revealSiblingsForDrag`) and back on drop. Our own edge auto-scroll replaces Sortable's. Disabled while editing so text selection isn't hijacked. Desktop single view also cycles lists on an 80px+ horizontal mouse drag over empty board.

### Desktop key map (normal mode)

| Key      | Action                                                           |
|----------|------------------------------------------------------------------|
| ↑ / ↓ (`k` / `j`) | Move selection within the list. Up off the first entry selects the list header (`entryIndex = -1`); down off the last wraps to the first. From the header, ↓ goes to the first entry, ↑ to the last |
| ← / → (`h` / `l`) | Switch to adjacent list; wraps at both ends, in both views |
| Shift+↑/↓ | Reorder selected entry within its list (wraps)                  |
| Shift+←/→ | If an entry is selected: move it to the adjacent list. If the list is selected: swap the list with its neighbour. Both wrap |
| Enter    | New entry below the selected one (at the top if the header is selected), in insert mode. Enter while editing a new entry: the first commits and stops, every following Enter in the same burst opens the next entry (`chainArmed`) |
| Tab      | Toggle the selected entry as the list's todo (one per list)      |
| Delete/Backspace | Delete selected entry, or — if the list itself is selected (`entryIndex = -1`) — delete the list. Skips the confirmation dialog when the list is empty. |
| `n`      | New list (empty name, ready to type; Esc removes the empty list) |
| `e`      | Edit current list name (or selected entry, if one is selected)   |
| `r`      | Delete current plan (confirm dialog; `Plan` is protected)        |
| `b`      | Set / clear background image URL for current plan                |
| `Space`  | Plan palette — fuzzy match, Enter switches plan. Up/Down (or Shift+J/K) wraps. Shift+↑/↓ with an empty query reorders plans; `Plan` stays put. While a query is typed, a `<New plan>` row sits at the bottom which opens the new-plan dialog. |
| `v`      | Toggle multi-list / single-list view (desktop only)              |
| `o`      | Open the selected entry's image in the full-screen preview       |
| Ctrl+V   | Attach a clipboard image to the selected entry (replaces any existing one). Also works while editing — that's how mobile attaches, via the long-press paste menu. |
| Ctrl+Shift+V | Remove the selected entry's image. Normal mode only, so it doesn't shadow paste-as-plain-text while editing. Not undoable. |
| Ctrl+Z   | Undo the last mutating action (create/delete/edit/reorder/move/todo/bg). Up to 5 deep. |
| Ctrl+C   | Copy the selected entry's text                                   |
| Esc      | Deselect the entry, keeping the list selected (modals handle their own close) |

### Mobile (detected via `matchMedia("(hover: none) and (pointer: coarse)")` OR a mobile UA regex; mirrored to `body.touch` so CSS gating survives Firefox/Zen UA spoofing)

- Defaults to single-list view (as does any window under 600px wide).
- Top bar (`#topbar`) is always visible on every device. On desktop it's a passive header showing the active plan name; `#m-view` is hidden and `#m-palette` has no click handler. On mobile both buttons are interactive — `#m-palette` opens the palette, `#m-view` toggles single/multi.
- The bottom action bar (`#actions`) is collapsed behind `#nav-toggle`, which toggles `body.nav-open`.
- Swipe to switch lists is gated to single-list view only. In multi-list view the touch scrolls the board naturally (no latching).
- Plan palette hides its search input on mobile (`body.touch #palette-input { display: none }`); the full list of plans is shown and tappable.
- Confirm-style dialogs render a `Confirm` submit button; hidden on desktop (Enter routes through `form.requestSubmit()`), visible on mobile.
- Tap empty space → deselect (single view drops only the entry selection, so the visible list stays; multi view clears both).
- **Touch while editing** (`insert` mode): a touch inside the active field places the caret / selects text; anything else commits the open field, and where it landed decides what follows — a **tap** on another entry or header **in the same list** opens the tapped one at the tapped spot (re-resolved by id via `editEntryById`/`editListById`, since the commit re-rendered the board); a tap anywhere else — another list, empty space — commits and deselects, like a background tap; a touch that **scrolled** commits and deselects without opening anything.
  - That decision can't be made when the finger lands (a touch on an entry is equally the start of a scroll), so `pointerdown` only *arms* it — recording the tap point and the same-list target while the node is still live — and `touchend`/`touchcancel` decides by travel distance (>10px = a scroll). Committing on press instead re-renders the board out from under the gesture: the `<ul>` being scrolled is detached mid-scroll, so the list freezes and the entry under the finger opens. The end listeners are on `document` in the bubble phase, so the swipe handler on `board` runs first and still sees `insert` — a scroll that drifts sideways must not also switch lists.
  - A tap `swallowNextClick()`s so the post-commit trailing click can't misfire against a detached node; a scroll doesn't, since it fires no click and swallowing would eat the next tap. Non-touch pointers (a mouse on a touch-capable device) fire no `touchend`, so they decide on press.
- With nothing selected (`listIndex < 0`), **delete-list** removes the last active list on the plan and **toggle-view** lands on it, via `resolvedListIndex()` (falls back to the first list). `state.lastListIndex` is updated in `render()` whenever a real list is selected.
- Tap entry: selects it and opens it for editing, caret at the tapped spot. Soft-keyboard Enter while editing commits, and may open a fresh entry below depending on the chain rule: Enter on an *unmodified* existing entry makes a new entry (Enter after actually editing just commits); the first new entry made after arriving at a list saves and stops (`firstEntryMade`), and every new entry after that chains. A chain that began from an explicit add (new list's first entry) keeps spawning entries on each Enter — fast bulk entry. The `chainable` flag threaded through `newEntryBelow`/`editEntry` carries this distinction; desktop follows its own rule (see Enter above). Committing a **new list's name** starts the chain only when it's committed with Enter (`chainOnCommit` in `editList`) — tapping/clicking away just creates the list. A `chainable` chain ends when the field is committed by a blur that isn't from Enter — i.e. tapping outside — which returns to normal mode without spawning another entry. A touch anywhere outside the live edit field commits it on lift (and recovers to normal mode if `insert` is somehow set with no focused field), so a stray touch can't leave the board stuck in `insert`.
- Tap a list's header (`.list-name`) to select that list (`entryIndex = -1`) and edit its name.
- Bottom action bar exposes `del-plan`, `new-list`, `del-list`, `toggle-todo` (the last mirrors desktop `Tab` — mark/unmark the selected entry). New plans are created from the palette's `<New plan>` row, not the action bar.
- Tap an entry's image to open the preview. It fills the viewport over a faded backdrop and carries its own bottom bar (`#img-actions` — open in new tab / delete image), because the real `#actions` sits behind the dialog's backdrop. Tapping anywhere that isn't the picture or that bar closes it — `#img-view` needs its own close handler rather than `attachBackdropClose`, since the letterboxing around a contained image would otherwise hit the `<img>`, not the dialog. Desktop drives the same dialog with `Delete`/`Backspace`, `n` (new tab) and `Esc`.
- All modal dialogs close on backdrop tap. Anything that dismisses a modal on `pointerdown` (backdrop, palette rows via `fastTap`, `.confirm-btn`) calls `swallowNextClick()` so the trailing click doesn't fall through to the board behind it.

## Styling — `public/styles.css`

Nord palette is exposed as CSS custom properties (`--darkest1`..`--darkest4`, `--lightest1`..`--lightest3`, `--red`/`--orange`/`--yellow`/`--green`/`--purple`, `--blue1`/`--blue2`/`--blue3`) plus semantic aliases (`--bg`, `--fg`, `--surface`, `--border`, `--accent`, `--danger`) and fonts (`--headerFont`, `--primaryFont`, `--ease`). Fonts (Hammersmith One + Sora) are self-hosted as `@font-face` rules pointing at `public/fonts/*.woff2` — served first-party by the Worker's ASSETS binding, no Google Fonts dependency. Sora is a variable font, so one file covers weights 300–600. To update a font, re-pull the woff2 from Google's CSS (with a modern browser UA) and save it under a new filename (it is cached `immutable`), updating the `@font-face` and preload URLs.

The "no buttons on desktop" rule lives in CSS: `#actions`, `#nav-toggle`, `#img-actions` and `.confirm-btn` are `display: none` by default and only shown under `body.touch`. The top bar is the one exception — always shown, but inert on desktop.

If you find yourself adding a desktop button, you're doing it wrong — bind a key instead.

## Invariants

- The `Plan` plan always exists (server- and client-enforced).
- One render path. Single-view is a CSS state, not a code fork.
- Routine saves are throttled to one KV write per `SAVE_INTERVAL` ms (5s); `saveNow()` (deletes, undo, images, background) writes at once. `beforeunload` shows the native unsaved-changes prompt while a write or upload is pending.
- The session cookie is `HttpOnly` — never read it from JS.
- No `img:` key survives that the blob doesn't reference. Enforced server-side on every write (`reconcile`) with a throttled `sweep` behind it; the client is never trusted to report a deletion.

## Cloudflare reference

There is no local dev loop — `PLAN_KV` is bound `remote`, so `wrangler dev` needs `wrangler login` and works against production data. `bun run deploy` to ship, `bunx wrangler secret put TURNSTILE_SECRET` to set the Turnstile secret. Images need no extra setup — they share `PLAN_KV`. Workers docs: https://developers.cloudflare.com/workers/. KV docs: https://developers.cloudflare.com/kv/.
