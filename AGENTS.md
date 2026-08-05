# AGENTS — operating manual

Read this first. The README has setup; this file has the design.

## Stack

Cloudflare Workers (`worker.ts`) + a KV namespace bound as `PLAN_KV` + an R2 bucket bound as `PLAN_R2` (entry images) + a static `ASSETS` binding pointing at `public/`. No bundler, no framework. The browser loads `public/index.html`, which imports `public/app.js` as a module and pulls SortableJS from a jsdelivr CDN.

When changing bindings: `npx wrangler types` (then re-run typecheck).

## Data model

```ts
type Entry = { id: string; text: string; todo?: boolean; image?: string };
type List  = { id: string; name: string; entries: Entry[] };
type Plan  = { id: string; name: string; lists: List[]; background?: string };
type Data  = { activePlanId: string; plans: Plan[]; version: number };
```

Stored as a single JSON blob at KV key `data`. `src/plan-store.ts` is the only thing that touches it. The plan named exactly `Plan` is special: enforced to exist by `putData`, and the client refuses to delete it.

## Images (`src/images.ts`)

One optional image per entry. `Entry.image` holds a uuid; the bytes live in the R2 bucket bound as `PLAN_R2` at `img/<uuid>`. Bytes never go in the blob — it is re-PUT in full on every save.

**No orphans, ever.** That invariant is enforced on the server, because every interesting failure (undo, a lost 409, a closed tab mid-upload) is one the client can't be trusted to report:

1. **`reconcile` on every `PUT /api/data`** — deletes `refs(current) \ refs(next)`. Every way an image stops being referenced (detach, entry/list/plan delete, undo, overwriting an entry's image) arrives as one blob replacing another, so the set difference catches all of them. Runs *after* `putData` commits: deleting first would risk a live reference to a deleted object, which is worse than an orphan.
2. **`sweep` on `GET /api/data`** — the backstop for ids that never reached any blob (upload succeeded, then the tab closed or the save lost a 409), which no diff can see. Throttled to one R2 list per 10 min via KV `sweep:at`, and skips objects younger than 15 min so it can't race an upload in flight.
3. **`dropMissingRefs` before every commit** — the mirror case. Only ids `current` didn't already carry are checked, so a normal save costs nothing and an attach costs one head.

The client's only job is to keep references honest:

- `scrubHistory()` (called from `save`/`saveNow`) strips from every undo snapshot any image id the live data no longer references, and prunes `imgCache` on the same pass. Without it, Ctrl+Z after a delete would restore a reference to bytes the server has already destroyed. **Consequence: removing an image is not undoable** — undo brings the entry back without its picture.
- `flushSave()` keeps entries that have an image when stripping blank ones. Dropping one would hide its reference from the server, whose diff would then delete an image still on screen.
- `healBrokenImage()` drops a reference on a **confirmed 404 only** (verified with a HEAD) — the same `error` event fires for a dropped connection, and discarding a live image over one lost packet can't be undone.
- An upload that finishes after its entry was deleted `DELETE`s its own object. That endpoint refuses any id the live blob references, so it cannot destroy an image in use.
- `imgCache` reuses one `<img>` element per id across renders, so the full-board repaint doesn't flash every picture. Responses are `immutable`-cached, since an id's bytes never change.

Pasting re-encodes through a canvas to max 1600px WebP (`encodeImage`), keeping whichever of the original/re-encode is smaller, and passing GIFs through untouched so animation survives. Server caps at 10 MB and accepts webp/png/jpeg/gif/avif.

An entry with an image but no text is legal — clearing the field leaves the picture rather than silently destroying it. Deleting the image from a text-less entry removes the entry.

⚠️ The `backup:` snapshots that `isDestructive` writes reference images that `reconcile` deletes on that same write. Restoring a week-old backup from the dashboard will therefore bring back entries whose images are gone; `healBrokenImage` clears those references on first paint. Zero orphans was the explicit requirement and this is its cost.

## Auth

- `auth:hash` in KV = sha256 hex of the password.
- `auth:secret` in KV = 32-byte hex HMAC key.
- Cookie: `session=<HMAC-SHA256("v1", secret)>`, HttpOnly, Secure, SameSite=Strict, Max-Age=31536000000 (~1000y).
- Cookie carries no per-user state. Rotating `auth:secret` invalidates all sessions. No KV reads per API call beyond fetching the secret.
- Constant-time compare for both password hash and cookie token.
- **Turnstile** gates `/api/auth`: the client sends the widget token alongside the password; the worker verifies it via `challenges.cloudflare.com/turnstile/v0/siteverify` (secret in `TURNSTILE_SECRET` — a Worker secret, set with `wrangler secret put TURNSTILE_SECRET`) before looking at the password. Site key (public) lives in `index.html`'s `.cf-turnstile[data-sitekey]`. The frontend resets the widget on any failure since tokens are single-use.
- **Rate limit**: `/api/auth` allows `RL_MAX` (3) attempts per IP per hour (fixed window in KV at `rl:auth:<ip>` = `{count, resetAt}`, keyed on `CF-Connecting-IP`). Order is Turnstile → rate-limit increment → password, so only valid-token submissions spend an attempt. Exceeding returns `429` with `Retry-After`.

## API

| Method | Path        | Behavior                                              |
|--------|-------------|-------------------------------------------------------|
| POST   | `/api/auth` | Verify Turnstile, rate-limit, check password, set cookie (403 bad challenge / 429 too many) |
| GET    | `/api/me`   | 204 if cookie valid, 401 otherwise                    |
| GET    | `/api/data` | Return full blob (seeds on first read if missing); triggers the throttled R2 sweep |
| PUT    | `/api/data` | Replace full blob; enforces `Plan` plan exists; drops missing image refs, then deletes newly-unreferenced R2 objects |
| POST   | `/api/img`  | Store an image body (≤10 MB, image types only) → `{ id }` |
| GET/HEAD | `/api/img/<id>` | Fetch one image, immutably cached (HEAD = existence probe) |
| DELETE | `/api/img/<id>` | Drop one object; **409 if the live blob references it** |

Everything else falls through to `env.ASSETS.fetch(req)`.

## Client architecture (`public/app.js`)

Four concerns, in this order in the file:

1. **State + persistence** — `state.data` mirrors the server. `save()` debounces 300ms; `saveNow()` flushes on mode transitions.
2. **Render** — one `render()` rebuilds `<main>` from scratch each call. The data set is tiny; do not optimize prematurely.
3. **Modes** — `body.dataset.mode` is `"normal" | "insert" | "palette" | "confirm" | "image"`. The desktop keyboard handler is a no-op in any non-`normal` mode. Exiting back to `normal` calls `saveNow()`.
   - **Undo** — `pushHistory()` deep-clones `state.data` + `selection` onto a 5-deep stack right before each mutating action; `undo()` (Ctrl+Z, normal mode only) pops and restores. Restored snapshots keep the live `state.data.version` so the next save doesn't 409. Abandoned creations (a new entry/list created then cancelled) call `popHistory()` to discard their snapshot, so undo never replays a no-op. `applyRemote()` clears the stack — its snapshots are relative to the superseded blob.
4. **Drag** — SortableJS, two groups (`"lists"` horizontal, `"entries"` for items). Single-view disables cross-list drag by setting `pull/put: false` — same render path, just an option flip.

### Desktop key map (normal mode)

| Key      | Action                                                           |
|----------|------------------------------------------------------------------|
| ↑ / ↓    | Move selection within current list; past either end → select the list itself (`entryIndex = -1`) |
| ← / →    | Switch to adjacent list                                          |
| Shift+↑/↓ | Reorder selected entry within its list                          |
| Shift+←/→ | If an entry is selected: move it to the adjacent list. If the list is selected: reorder the list itself |
| Enter    | New entry below the selected one (cursor in insert mode)         |
| Delete/Backspace | Delete selected entry, or — if the list itself is selected (`entryIndex = -1`) — delete the list. Skips the confirmation dialog when the list is empty. |
| `n`      | New list (empty name, ready to type; Esc removes the empty list) |
| `e`      | Edit current list name (or selected entry, if one is selected)   |
| `r`      | Delete current plan (confirm dialog; `Plan` is protected)        |
| `b`      | Set / clear background image URL for current plan                |
| `Space`  | Plan palette — fuzzy match, Enter switches plan. Always shows a `<New plan>` row at the bottom which opens the new-plan confirm dialog. |
| `v`      | Toggle multi-list / single-list view (desktop only)              |
| `o`      | Open the selected entry's image in the full-screen preview       |
| Ctrl+V   | Attach a clipboard image to the selected entry (replaces any existing one). Also works while editing — that's how mobile attaches, via the long-press paste menu. |
| Ctrl+Shift+V | Remove the selected entry's image. Normal mode only, so it doesn't shadow paste-as-plain-text while editing. Not undoable. |
| Ctrl+Z   | Undo the last mutating action (create/delete/edit/reorder/move/bg). Up to 5 deep. |
| Ctrl+C   | Copy the selected entry's text                                   |
| Esc      | Forces save (insert/palette/confirm modals handle their own close) |

### Mobile (detected via `matchMedia("(hover: none) and (pointer: coarse)")` OR a mobile UA regex; mirrored to `body.touch` so CSS gating survives Firefox/Zen UA spoofing)

- Defaults to single-list view.
- Top bar (`#topbar`) is always visible on every device. On desktop it's a passive header showing the active plan name; `#m-view` is hidden and `#m-palette` has no click handler. On mobile both buttons are interactive — `#m-palette` opens the palette, `#m-view` toggles single/multi.
- Swipe to switch lists is gated to single-list view only. In multi-list view the touch scrolls the board naturally (no latching).
- Plan palette hides its search input on mobile (`body.touch #palette-input { display: none }`); the full list of plans is shown and tappable.
- Confirm-style dialogs render a `Confirm` submit button; hidden on desktop (Enter routes through `form.requestSubmit()`), visible on mobile.
- Swipe horizontally on the board → switch list.
- Tap empty space → normal mode.
- **Touch while editing** (`insert` mode): a touch inside the active field places the caret / selects text; anything else commits the open field, and where it landed decides what follows — a **tap** on another entry or header **in the same list** opens the tapped one at the tapped spot (re-resolved by id via `editEntryById`/`editListById`, since the commit re-rendered the board); a tap anywhere else — another list, empty space — commits and deselects, like a background tap; a touch that **scrolled** commits and deselects without opening anything.
  - That decision can't be made when the finger lands (a touch on an entry is equally the start of a scroll), so `pointerdown` only *arms* it — recording the tap point and the same-list target while the node is still live — and `touchend`/`touchcancel` decides by travel distance (>10px = a scroll). Committing on press instead re-renders the board out from under the gesture: the `<ul>` being scrolled is detached mid-scroll, so the list freezes and the entry under the finger opens. The end listeners are on `document` in the bubble phase, so the swipe handler on `board` runs first and still sees `insert` — a scroll that drifts sideways must not also switch lists.
  - A tap `swallowNextClick()`s so the post-commit trailing click can't misfire against a detached node; a scroll doesn't, since it fires no click and swallowing would eat the next tap. Non-touch pointers (a mouse on a touch-capable device) fire no `touchend`, so they decide on press.
- With nothing selected (`listIndex < 0`), **delete-list** removes the last active list on the plan and **toggle-view** lands on it, via `resolvedListIndex()` (falls back to the first list). `state.lastListIndex` is updated in `render()` whenever a real list is selected.
- Tap entry: selects + visually highlights. Double-tap within 300ms → edit. Soft-keyboard Enter while editing commits, and may open a fresh entry below depending on the chain rule: editing an *existing* entry + Enter makes one new entry, but Enter on that new entry stops (no runaway chaining). A chain that began from an explicit add (new list's first entry) keeps spawning entries on each Enter — fast bulk entry. The `chainable` flag threaded through `newEntryBelow`/`editEntry` carries this distinction; desktop is unaffected (only new entries chain). Committing a **new list's name** starts the chain only when it's committed with Enter (`chainOnCommit` in `editList`) — tapping/clicking away just creates the list. A `chainable` chain ends when the field is committed by a blur that isn't from Enter — i.e. tapping outside — which returns to normal mode without spawning another entry. A touch anywhere outside the live edit field commits it on lift (and recovers to normal mode if `insert` is somehow set with no focused field), so a stray touch can't leave the board stuck in `insert`.
- Tap a list's header (`.list-name`) to select that list (`entryIndex = -1`); useful in multi-list view for picking a list to edit or delete.
- Bottom action bar exposes `del-plan`, `new-list`, `del-list`, `toggle-todo` (the last mirrors desktop `Tab` — mark/unmark the selected entry). New plans are created from the palette's `<New plan>` row, not the action bar.
- Single-list view wraps when paging past either end (swipe / arrows / desktop drag-cycle all route through `move`); multi-list view clamps.
- Tap an entry's image to open the preview. It fills the viewport over a faded backdrop and carries its own bottom bar (`#img-actions` — open in new tab / delete image), because the real `#actions` sits behind the dialog's backdrop. Tapping anywhere that isn't the picture or that bar closes it — `#img-view` needs its own close handler rather than `attachBackdropClose`, since the letterboxing around a contained image would otherwise hit the `<img>`, not the dialog. Desktop drives the same dialog with `Delete`/`Backspace`, `n` (new tab) and `Esc`.
- All modal dialogs close on backdrop tap. Anything that dismisses a modal on `pointerdown` (backdrop, palette rows via `fastTap`, `.confirm-btn`) calls `swallowNextClick()` so the trailing click doesn't fall through to the board behind it.

## Styling — `public/styles.css`

Nord palette is exposed as CSS custom properties (`--darkest1`..`--darkest4`, `--lightest1`..`--lightest3`, `--red`/`--orange`/`--yellow`/`--green`/`--purple`, `--blue1`/`--blue2`/`--blue3`) plus semantic aliases (`--bg`, `--fg`, `--surface`, `--border`, `--accent`, `--danger`) and fonts (`--headerFont`, `--primaryFont`, `--ease`). Fonts (Hammersmith One + Sora) are self-hosted as `@font-face` rules pointing at `public/fonts/*.woff2` — served first-party by the Worker's ASSETS binding, no Google Fonts dependency. Sora is a variable font, so one file covers weights 300–600. To update a font, re-pull the woff2 from Google's CSS (with a modern browser UA) and replace the file. The file ships with only the bare layout required: board scroll, dialogs, single-view centering, dot indicators. Extend here.

The "no buttons on desktop" rule lives in CSS:

```css
@media (hover: hover) and (pointer: fine) {
  #topbar, #actions { display: none !important; }
}
```

If you find yourself adding a desktop button, you're doing it wrong — bind a key instead.

## Invariants

- The `Plan` plan always exists (server- and client-enforced).
- One render path. Single-view is a CSS state, not a code fork.
- KV writes are throttled to at most one per `SAVE_INTERVAL` ms (5s); `beforeunload` shows the native unsaved-changes prompt while a write is pending.
- The session cookie is `HttpOnly` — never read it from JS.
- R2 holds no object the blob doesn't reference, and the blob holds no reference R2 can't satisfy. Both directions are enforced server-side on every write; the client is never trusted to report a deletion.

## Cloudflare reference

There is no local dev loop — everything runs in production. `npx wrangler deploy` to ship, `npx wrangler types` after binding changes, `npx wrangler secret put TURNSTILE_SECRET` to set the Turnstile secret. The image bucket is created once with `npx wrangler r2 bucket create plan-images`. Workers docs: https://developers.cloudflare.com/workers/. KV docs: https://developers.cloudflare.com/kv/.
