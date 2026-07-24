# AGENTS — operating manual

Read this first. The README has setup; this file has the design.

## Stack

Cloudflare Workers (`worker.ts`) + a KV namespace bound as `PLAN_KV` + a static `ASSETS` binding pointing at `public/`. No bundler, no framework. The browser loads `public/index.html`, which imports `public/app.js` as a module and pulls SortableJS from a jsdelivr CDN.

When changing bindings: `npx wrangler types` (then re-run typecheck).

## Data model

```ts
type Entry = { id: string; text: string };
type List  = { id: string; name: string; entries: Entry[] };
type Plan  = { id: string; name: string; lists: List[] };
type Data  = { activePlanId: string; plans: Plan[] };
```

Stored as a single JSON blob at KV key `data`. `src/plan-store.ts` is the only thing that touches it. The plan named exactly `Plan` is special: enforced to exist by `putData`, and the client refuses to delete it.

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
| GET    | `/api/data` | Return full blob (seeds on first read if missing)     |
| PUT    | `/api/data` | Replace full blob; enforces `Plan` plan exists        |

Everything else falls through to `env.ASSETS.fetch(req)`.

## Client architecture (`public/app.js`)

Four concerns, in this order in the file:

1. **State + persistence** — `state.data` mirrors the server. `save()` debounces 300ms; `saveNow()` flushes on mode transitions.
2. **Render** — one `render()` rebuilds `<main>` from scratch each call. The data set is tiny; do not optimize prematurely.
3. **Modes** — `body.dataset.mode` is `"normal" | "insert" | "palette" | "confirm"`. The desktop keyboard handler is a no-op in any non-`normal` mode. Exiting back to `normal` calls `saveNow()`.
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
- **Tap while editing** (`insert` mode, handled on `pointerdown`): a tap inside the active field places the caret / selects text; a tap on another entry or header **in the same list** commits the current field and immediately opens the tapped one at the tapped spot (re-resolved by id via `editEntryById`/`editListById`, since the commit re-rendered the board); a tap anywhere else — another list or empty space — commits and fully deselects, exactly like a background tap. Every branch `swallowNextClick()`s so the post-commit trailing click can't misfire against a detached node.
- With nothing selected (`listIndex < 0`), **delete-list** removes the last active list on the plan and **toggle-view** lands on it, via `resolvedListIndex()` (falls back to the first list). `state.lastListIndex` is updated in `render()` whenever a real list is selected.
- Tap entry: selects + visually highlights. Double-tap within 300ms → edit. Soft-keyboard Enter while editing commits, and may open a fresh entry below depending on the chain rule: editing an *existing* entry + Enter makes one new entry, but Enter on that new entry stops (no runaway chaining). A chain that began from an explicit add (new list's first entry) keeps spawning entries on each Enter — fast bulk entry. The `chainable` flag threaded through `newEntryBelow`/`editEntry` carries this distinction; desktop is unaffected (only new entries chain). Committing a **new list's name** starts the chain only when it's committed with Enter (`chainOnCommit` in `editList`) — tapping/clicking away just creates the list. A `chainable` chain ends when the field is committed by a blur that isn't from Enter — i.e. tapping outside — which returns to normal mode without spawning another entry. A pointerdown anywhere outside the live edit field commits it (and recovers to normal mode if `insert` is somehow set with no focused field), so a stray tap can't leave the board stuck in `insert`.
- Tap a list's header (`.list-name`) to select that list (`entryIndex = -1`); useful in multi-list view for picking a list to edit or delete.
- Bottom action bar exposes `del-plan`, `new-list`, `del-list`, `toggle-todo` (the last mirrors desktop `Tab` — mark/unmark the selected entry). New plans are created from the palette's `<New plan>` row, not the action bar.
- Single-list view wraps when paging past either end (swipe / arrows / desktop drag-cycle all route through `move`); multi-list view clamps.
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

## Cloudflare reference

There is no local dev loop — everything runs in production. `npx wrangler deploy` to ship, `npx wrangler types` after binding changes, `npx wrangler secret put TURNSTILE_SECRET` to set the Turnstile secret. Workers docs: https://developers.cloudflare.com/workers/. KV docs: https://developers.cloudflare.com/kv/.
