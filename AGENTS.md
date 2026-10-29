# AGENTS — operating manual

## Stack
- Bun server (`server.ts`, `Bun.serve`) over one SQLite file (`bun:sqlite`, `<dataDir>/plan.db`: data blob, entry images, backups); serves static build from `dist/`.
- No framework, no runtime deps (Bun built-ins only); `bun install` = typechecking only.
- `build.ts` (Nix build + `bun run dev`) copies `public/` → `dist/`, minifies `app.js`/`styles.css`, strips HTML comments (sources stay heavily commented free). Edit `public/`, never `dist/` (gitignored).
- `public/index.html` imports `public/app.js` as module; vendored `public/Sortable.min.js` loaded `async` (drag attaches on arrival, never delays first paint).
- Listens `127.0.0.1:8787`; only setting `PLAN_DATA_DIR` (default `./data`). Blob cached in memory after first read (sole writer) → stop service before hand-editing `plan.db`. `bun run typecheck` after server changes.

Deployment:
- `flake.nix`: no inputs, one output `overlays.default` → `pkgs.plan` on host nixpkgs: `dist/` from `build.ts` + server bundled by `bun build --minify` into one `server.js`.
- `server.js` listens on import; homelab's existing bun webserver does `await import(process.env.PLAN_SERVER)` (saves a runtime). Shared process, separate sockets (webserver `:80`, plan `127.0.0.1:8787`); crash in either kills both.
- Page shell rewritten once at startup and split; serving `/` = string concat.
- HTTPS + tailnet-only via `tailscale serve`, run once by hand (`sudo tailscale serve --bg 8787`); persisted by tailscaled. HTTPS required anyway (`crypto.randomUUID`, clipboard need secure context).
- No auth; tailnet membership is auth. Never bind public.

## Data model
```ts
type Entry = {
  id: string;
  text: string;
  todo?: boolean;
  image?: string;
  imageSize?: [number, number];
};
type List = { id: string; name: string; entries: Entry[] };
type Plan = { id: string; name: string; lists: List[]; background?: string };
type Data = { activePlanId: string; plans: Plan[]; version: number };
```
Single JSON blob, one row of table `data`. Only `src/plan-store.ts` touches it. Plan named exactly `Plan` is special: `putData` enforces it exists; client refuses delete.

## Images (`src/images.ts`)
- One optional image per entry. `Entry.image` = uuid; bytes in table `images` (`id, ct, at, bytes`), same DB. Never in blob (blob re-PUT in full every save). `isImageId` gates every id by uuid regex.
- Client stale-read guards (`objectUrls`, strictly-newer checks) rarely fire (SQLite reads fresh) but are cheap, correct, and cover refresh racing save.

No orphans, ever. Enforced server-side (client can't be trusted to report undo, lost 409, closed tab mid-upload):
1. `reconcile` on every `PUT /api/data`: deletes `refs(current) \ refs(next)`. Every unreference (detach, entry/list/plan delete, undo, overwrite) is blob replacing blob → set diff catches all. Same transaction as write (`saveData` in `server.ts`).
2. `sweep` hourly (timer in `server.ts` + once at startup): backstop for ids never reaching a blob (upload ok, then tab closed / save lost 409). Skips rows with `at` < 24 h. Grace generous on purpose: unreferenced from upload until save lands, indefinitely if client offline with pending write. Late collection costs nothing; collecting in-transit ref is unrecoverable.

No "id exists?" check before committing a reference: client sets refs only after 201; `healBrokenImage` handles truly missing.

Client keeps refs honest, never acts on stale read:
- `scrubHistory()` (from `save`/`saveNow`) strips from undo snapshots any image id live data no longer refs; prunes `imgCache`/`objectUrls` same pass. Else Ctrl+Z after delete restores ref to destroyed bytes. Consequence: image removal not undoable (undo restores entry without picture).
- `flushSave()` keeps entries with an image when stripping blank ones (else server diff deletes on-screen image).
- `objectUrls`: blob URL per image uploaded this session; `imgSrc()` prefers it (skips round-trip).
- `healBrokenImage()` drops ref only on confirmed 404 (HEAD), never for id in `objectUrls` (our upload → 404 = stale read). `error` also fires on dropped connection; discarding live image is irreversible.
- `refresh()` and `flushSave()` 409 branch adopt remote blob only if version strictly newer. Stale read would roll back own edits, and lost image ref gets bytes deleted by next diff. 409 vs stale read isn't real conflict → write stays pending, retries.
- Upload finishing after its entry was deleted `DELETE`s own image. Route refuses ids the live blob refs AND ids older than 1 h (stale blob can't trick it into deleting established image).
- `imgCache` reuses one `<img>` per id across renders (no flash on full repaint). Responses `immutable` (id bytes never change).

- Paste re-encodes via canvas to max 1600px WebP (`encodeImage`), keeps smaller of original/re-encode; GIFs pass through (animation). Server cap 10 MB; webp/png/jpeg/gif/avif.
- `Entry.imageSize` = natural `[w, h]` at upload (backfilled on first load for old images). `.entry img.sized` reserves box → no layout shift, first-paint reveal doesn't wait. Cleared with `image` everywhere.
- Image without text is legal (clearing text keeps picture). Deleting image from text-less entry removes entry.

## Backups
Write deleting a plan or list (`isDestructive`) first snapshots replaced blob into `backups` (`at` = ms), pruned after 7 days. Restore by hand, service stopped (blob cached), bump version so open clients 409 and adopt instead of looping:

```sh
sudo systemctl stop plan
sqlite3 plan.db "SELECT at, datetime(at/1000,'unixepoch','localtime') FROM backups"
sqlite3 plan.db "UPDATE data SET json = json_set((SELECT json FROM backups WHERE at = <at>), '\$.version', json_extract(json, '\$.version') + 1)"
sudo systemctl start plan
```

⚠️ Backups ref images `reconcile` deleted on that same write; restored entries lose images; `healBrokenImage` clears refs on first paint. Cost of zero-orphans requirement.

## Security
- No auth; tailnet = access control.
- `harden()` in `server.ts`, every response: page CSP (scripts self only, `frame-ancestors 'none'`), `nosniff`, `Referrer-Policy: no-referrer`, HSTS. `/api/` responses without own `Cache-Control` get `no-store`. New third-party script/frame → add to `CSP`.
- Static files resolved under `dist/`; escape refused.

## API
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/data` | full blob (seeds on first read if missing); 304 if `X-Plan-Version` is current |
| PUT | `/api/data` | replace blob (409 + current if `X-Plan-Version` stale); enforces `Plan`; deletes newly-unreferenced images same transaction |
| POST | `/api/img` | store image (≤10 MB, image types) → `{ id }` |
| GET/HEAD | `/api/img/<id>` | fetch, immutable (HEAD = existence probe) |
| DELETE | `/api/img/<id>` | drop; 409 if live blob refs it |

`GET /` (`servePage`, Bun `HTMLRewriter`):
- Blob inlined as `<script id="boot" type="application/json">` (absent if read failed → client fetches `/api/data`, retry 3s).
- `styles.css`/`app.js` linked `?v=<content hash>`, served `immutable`; shell + hashes computed once at startup → repeat loads download nothing, reuse compiled-code cache.
- Preloads unsized images of active plan + background (fonts preloaded by `index.html`).
- Response `no-store` (private data).
- Client keeps `body` children `visibility: hidden` until `reveal()` (render done, fonts loaded, unsized images decoded, cap 1.5s) → first frame = final layout.
- Rest = files from `dist/` (`serveAsset`). `cacheControl()` marks fonts + `Sortable.min.js` `immutable` 1 year: rename file when replacing.

## Client (`public/app.js`)
Four concerns, in file order:
1. State + persistence: `state.data` mirrors server. `save()` throttles one PUT per `SAVE_INTERVAL` (5s); `saveNow()` immediate for destructive (deletes, undo, images, background).
2. Render: one `render()` reconciles `<main>` by list/entry id (`listEls`/`entryEls` maps; `_k`/`_f`/`_sel`/`_items` node caches) and touches only what changed; Sortables kept per element. Servo pays per DOM call + per reflow (full rebuild ≈ 10× slower there). Code that hollows out a node (editors) resets its `_k`. Measure before writes, write after (`scrollSelectionIntoView`): one forced layout per action.
3. Modes: `body.dataset.mode` = `"normal" | "insert" | "palette" | "confirm" | "image"` (background dialog reuses `palette`). Desktop key handler no-op outside `normal`.
   - Undo: `pushHistory()` deep-clones `state.data` + `selection` onto 5-deep stack before each mutation; `undo()` (Ctrl+Z, normal only) restores. Restored snapshots keep live `state.data.version` (no 409). Abandoned creations pop their snapshot (no no-op undo). `applyRemote()` clears stack.
4. Drag: SortableJS, groups `"lists"` (horizontal), `"entries"`. Cross-list in single view: drag flips to multi view for duration (`onStart` in `attachSortables`), back on drop. Own edge auto-scroll replaces Sortable's. Disabled while editing (text selection). Desktop single view cycles lists on 80px+ horizontal mouse drag over empty board.

### Desktop keys (normal mode)
| Key | Action |
|---|---|
| ↑/↓ (`k`/`j`) | Move in list. Up off first → list header (`entryIndex = -1`); down off last wraps to first. Header: ↓ first entry, ↑ last |
| ←/→ (`h`/`l`) | Adjacent list; wraps, both views |
| Shift+↑/↓ | Reorder entry in list (wraps) |
| Shift+←/→ | Entry selected: move to adjacent list. List selected: swap with neighbour. Both wrap |
| Enter | New entry below (top if header), insert mode. While editing new entry: first Enter commits + stops; following Enters in same burst open next entry (`chainArmed`) |
| Tab | Toggle entry as list's todo (one per list) |
| Delete/Backspace | Delete entry, or list if header selected; no confirm if list empty |
| `n` | New list (empty name; Esc removes empty list) |
| `e` | Edit list name (or selected entry) |
| `r` | Delete plan (confirm; `Plan` protected) |
| `b` | Set/clear plan background URL |
| `Space` | Plan palette: fuzzy, Enter switches. Up/Down (Shift+J/K) wraps. Shift+↑/↓ with empty query reorders plans (`Plan` fixed). With query, bottom `<New plan>` row creates plan named after query, opens first list name for edit |
| `v` | Toggle multi/single view (desktop) |
| `o` | Open entry image full-screen |
| Ctrl+V | Attach clipboard image (replaces). Works while editing (mobile long-press paste) |
| Ctrl+Shift+V | Remove entry image. Normal only (don't shadow paste-plain). Not undoable |
| Ctrl+Z | Undo create/delete/edit/reorder/move/todo/bg, 5 deep |
| Ctrl+C | Copy entry text |
| Esc | Deselect entry, keep list (modals own close) |

### Mobile
Detected via `matchMedia("(hover: none) and (pointer: coarse)")` OR mobile UA regex; mirrored to `body.touch` (survives Firefox/Zen UA spoofing).
- Default single view (also any window < 600px).
- `#topbar` always visible. Desktop: passive header with plan name, `#m-view` hidden, `#m-palette` no handler. Mobile: `#m-palette` opens palette, `#m-view` toggles view.
- `#actions` collapsed behind `#nav-toggle` (toggles `body.nav-open`).
- Swipe-to-switch lists only in single view; multi view scrolls naturally (no latching).
- Palette hides search input on mobile (`body.touch #palette-input { display: none }`); full tappable list.
- Confirm dialogs render `Confirm` button; hidden desktop (Enter → `form.requestSubmit()`).
- Tap empty space → deselect (single: entry only; multi: both).
- Touch while editing (`insert`): inside active field = caret/selection. Elsewhere commits; then: tap on entry/header in same list opens it at tapped spot (re-resolved by id via `editEntryById`/`editListById`, board re-rendered); tap elsewhere commits + deselects; touch that scrolled commits + deselects, opens nothing.
  - Can't decide at press (could be scroll start): `pointerdown` only arms (records point + same-list target while node live); `touchend`/`touchcancel` decides by travel (>10px = scroll). Committing on press re-renders mid-scroll (detached `<ul>`, list freezes, entry under finger opens). End listeners on `document` bubble phase → `board` swipe handler runs first, still sees `insert` (sideways-drifting scroll mustn't switch lists).
  - Tap `swallowNextClick()`s (trailing click vs detached node); scroll doesn't (no click; would eat next tap). Non-touch pointers fire no `touchend` → decide on press.
- Nothing selected (`listIndex < 0`): delete-list removes last active list, toggle-view lands on it, via `resolvedListIndex()` (falls back to first). `state.lastListIndex` updated in `render()` when real list selected.
- Tap entry: select + edit, caret at tap. Soft-keyboard Enter commits and always opens fresh entry below (keyboard stays up); Enter on blank commits nothing, stops. `chainable` flag through `newEntryBelow`/`editEntry` marks new-list flow (chains on desktop too); else desktop follows its Enter rule. New list name starts chain only if committed with Enter (`chainOnCommit` in `editList`); tap away just creates list. Chain ends on non-Enter blur (tap outside) → normal mode. Touch outside live field commits on lift (recovers to normal if `insert` with no focused field).
- Tap `.list-name`: select list (`entryIndex = -1`), edit name.
- `#actions`: `del-plan`, `new-list`, `del-list`, `toggle-todo` (= desktop Tab). New plans via palette `<New plan>` only.
- Tap entry image → preview: fills viewport, faded backdrop, own bar `#img-actions` (new tab / delete) since `#actions` is behind backdrop. Tap outside picture/bar closes; `#img-view` has own close handler, not `attachBackdropClose` (letterboxing hits `<img>`). Desktop: `Delete`/`Backspace`, `n` (new tab), `Esc`.
- All modals close on backdrop tap. Anything dismissing on `pointerdown` (backdrop, palette rows via `fastTap`, `.confirm-btn`) calls `swallowNextClick()`.

## Styling (`public/styles.css`)
- Nord as custom props (`--darkest1`..`--darkest4`, `--lightest1`/`--lightest3`, `--blue2`/`--blue3`; only used ones) + aliases (`--bg`, `--fg`, `--surface`, `--border`, `--accent`) + `--headerFont`, `--primaryFont`, `--ease`.
- Fonts self-hosted `@font-face` → `public/fonts/*.woff2` (Hammersmith One, Sora variable 300–600). Update: re-pull woff2 from Google CSS (modern UA), save under new filename (immutable cache), update `@font-face` + preload URLs.
- No desktop buttons: `#actions`, `#nav-toggle`, `#img-actions`, `.confirm-btn` `display: none` unless `body.touch`. Top bar = exception (shown, inert on desktop). Adding a desktop button = wrong; bind a key.

## Invariants
- `Plan` plan always exists (server + client).
- One render path. Single view = CSS state, not code fork.
- Routine saves ≤ one per `SAVE_INTERVAL` (5s); `saveNow()` (deletes, undo, images, background) immediate. `beforeunload` shows native prompt while write/upload pending.
- No image row the blob doesn't ref. Server `reconcile` every write + periodic `sweep`; client never trusted to report deletions.

## Dev
`bun run dev` → `http://127.0.0.1:8787`, data `./data/plan.db` (localhost = secure context).
