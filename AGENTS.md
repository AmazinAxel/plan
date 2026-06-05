# AGENTS — operating manual

Read this first. The README has setup; this file has the design.

## Stack

Cloudflare Workers (`worker.ts`) + a KV namespace bound as `PLAN_KV` + a static `ASSETS` binding pointing at `public/`. No bundler, no framework. The browser loads `public/index.html`, which imports `public/app.js` as a module and the vendored `public/vendor/sortable.min.js` as a classic script.

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

## API

| Method | Path        | Behavior                                              |
|--------|-------------|-------------------------------------------------------|
| POST   | `/api/auth` | Check password, set cookie                            |
| GET    | `/api/me`   | 204 if cookie valid, 401 otherwise                    |
| GET    | `/api/data` | Return full blob (seeds on first read if missing)     |
| PUT    | `/api/data` | Replace full blob; enforces `Plan` plan exists        |

Everything else falls through to `env.ASSETS.fetch(req)`.

## Client architecture (`public/app.js`)

Four concerns, in this order in the file:

1. **State + persistence** — `state.data` mirrors the server. `save()` debounces 300ms; `saveNow()` flushes on mode transitions.
2. **Render** — one `render()` rebuilds `<main>` from scratch each call. The data set is tiny; do not optimize prematurely.
3. **Modes** — `body.dataset.mode` is `"normal" | "insert" | "palette" | "confirm"`. The desktop keyboard handler is a no-op in any non-`normal` mode. Exiting back to `normal` calls `saveNow()`.
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
| `n`      | New list (empty name, ready to type)                             |
| `m`      | New plan — modal prompts for name; Enter creates, Esc cancels    |
| `e`      | Edit current list name (or selected entry, if one is selected)   |
| `r`      | Delete current plan (confirm dialog; `Plan` is protected)        |
| `:`      | Plan palette — fuzzy match, Enter switches plan                  |
| `v`      | Toggle multi-list / single-list view (desktop only)              |
| Esc      | Forces save (insert/palette/confirm modals handle their own close) |

### Mobile (detected via `matchMedia("(hover: none) and (pointer: coarse)")` OR a mobile UA regex; mirrored to `body.touch` so CSS gating survives Firefox/Zen UA spoofing)

- Defaults to single-list view.
- Top bar (`#topbar`) is always visible on every device. On desktop it's a passive header showing the active plan name; `#m-view` is hidden and `#m-palette` has no click handler. On mobile both buttons are interactive — `#m-palette` opens the palette, `#m-view` toggles single/multi.
- Swipe to switch lists is gated to single-list view only. In multi-list view the touch scrolls the board naturally (no latching).
- Plan palette hides its search input on mobile (`body.touch #palette-input { display: none }`); the full list of plans is shown and tappable.
- Confirm-style dialogs render a `Confirm` submit button; hidden on desktop (Enter routes through `form.requestSubmit()`), visible on mobile.
- Swipe horizontally on the board → switch list.
- Tap empty space → normal mode.
- Tap entry: selects + visually highlights. Double-tap within 300ms → edit. Pressing the soft-keyboard Enter while editing commits and immediately opens a fresh entry below — fast bulk entry.
- Tap a list's header (`.list-name`) to select that list (`entryIndex = -1`); useful in multi-list view for picking a list to edit or delete.
- Bottom action bar exposes `new-plan`, `new-list`, `edit-list`, `del-list`, `new-entry`.
- All modal dialogs close on backdrop tap.

## Styling — `public/styles.css`

Nord palette is exposed as CSS custom properties (`--darkest1`..`--darkest4`, `--lightest1`..`--lightest3`, `--red`/`--orange`/`--yellow`/`--green`/`--purple`, `--blue1`/`--blue2`/`--blue3`) plus semantic aliases (`--bg`, `--fg`, `--surface`, `--border`, `--accent`, `--danger`) and fonts (`--headerFont`, `--primaryFont`, `--ease`). Fonts are loaded from Google Fonts (Hammersmith One + Sora). The file ships with only the bare layout required: board scroll, dialogs, single-view centering, dot indicators. Extend here.

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

`npx wrangler dev` to develop, `npx wrangler deploy` to ship, `npx wrangler types` after binding changes. Workers docs: https://developers.cloudflare.com/workers/. KV docs: https://developers.cloudflare.com/kv/.
