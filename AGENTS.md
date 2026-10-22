# AGENTS — operating manual

## Stack

A Bun server (`server.ts`, `Bun.serve`) over one SQLite file (`bun:sqlite`, `<dataDir>/plan.db`: data blob, entry images, backups), serving the static build from `dist/`. No framework and **no runtime dependencies** — only Bun built-ins; `bun install` is for typechecking alone. `build.ts` (run by the Nix build and `bun run dev`) copies `public/` into `dist/`, minifying `app.js`/`styles.css` and stripping HTML comments, so sources stay heavily commented at no network cost. Edit `public/`, never `dist/` (gitignored). The browser loads `public/index.html`, which imports `public/app.js` as a module and loads the vendored `public/Sortable.min.js` `async` (drag attaches once it arrives, so it never delays first paint).

Listens on `127.0.0.1:8787`; the only setting is `PLAN_DATA_DIR` (default `./data`). The blob is held in memory after the first read (this process is the only writer), so **stop the service before editing `plan.db` by hand**. `bun run typecheck` after server changes.

**Deployment** is `flake.nix`, which has no inputs and one output, `overlays.default`, providing `pkgs.plan` built with the host's nixpkgs: `dist/` from `build.ts`, and the server bundled by `bun build --minify` into one `server.js`. That file starts its listener on import, so the homelab doesn't run it as its own service: its existing bun webserver does `await import(process.env.PLAN_SERVER)`, saving a second runtime's memory. The two share a process but not a socket — the webserver stays on `:80`, plan on `127.0.0.1:8787` — and a crash in either takes down both. The page shell is rewritten once at startup and split, so serving `/` is string concatenation. HTTPS and tailnet-only access come from `tailscale serve`, run once by hand on the host (`sudo tailscale serve --bg 8787`); tailscaled keeps that setting in its own state. HTTPS is needed anyway: `crypto.randomUUID` and the clipboard require a secure context. **There is no auth** — tailnet membership is the auth. Never bind it to a public interface.

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

Stored as a single JSON blob, the one row of table `data`. `src/plan-store.ts` is the only thing that touches it. The plan named exactly `Plan` is special: enforced to exist by `putData`, and the client refuses to delete it.

## Images (`src/images.ts`)

One optional image per entry. `Entry.image` holds a uuid; the bytes live in table `images` (`id, ct, at, bytes`) of the same database. Bytes never go in the data blob — it is re-PUT in full on every save. `isImageId` gates every id against a uuid regex.

Some client-side care below — `objectUrls`, the strictly-newer checks — guards against stale reads. SQLite reads are always fresh, so these rarely fire, but they are correct and cheap, and they also cover a refresh racing a save.

**No orphans, ever.** That invariant is enforced on the server, because every interesting failure (undo, a lost 409, a closed tab mid-upload) is one the client can't be trusted to report:

1. **`reconcile` on every `PUT /api/data`** — deletes `refs(current) \ refs(next)`. Every way an image stops being referenced (detach, entry/list/plan delete, undo, overwriting an entry's image) arrives as one blob replacing another, so the set difference catches all of them. Runs in the same transaction as the write (`saveData` in `server.ts`), so the blob and its image cleanup commit together.
2. **`sweep` hourly** (a timer in `server.ts`, plus once at startup) — the backstop for ids that never reached any blob (upload succeeded, then the tab closed or the save lost a 409), which no diff can see. Skips rows whose `at` is under 24 h old. That grace is deliberately generous: an image is unreferenced from upload until its save lands, a gap that stretches indefinitely if the client goes offline holding a pending write. Collecting a rare abandoned upload a day late costs nothing; collecting one whose reference was merely in transit is unrecoverable.

There is deliberately **no "does this id exist?" check before committing a reference**. The client only ever sets a reference after a 201, and `healBrokenImage` handles the genuinely-missing case.

The client's job is to keep references honest, and to never act on a stale read:

- `scrubHistory()` (called from `save`/`saveNow`) strips from every undo snapshot any image id the live data no longer references, and prunes `imgCache`/`objectUrls` on the same pass. Without it, Ctrl+Z after a delete would restore a reference to bytes the server has already destroyed. **Consequence: removing an image is not undoable** — undo brings the entry back without its picture.
- `flushSave()` keeps entries that have an image when stripping blank ones. Dropping one would hide its reference from the server, whose diff would then delete an image still on screen.
- `objectUrls` holds a blob URL for every image uploaded this session and `imgSrc()` prefers it over the network, skipping a round-trip.
- `healBrokenImage()` drops a reference on a **confirmed 404 only** (verified with a HEAD), and never for an id in `objectUrls` — we uploaded it, so a 404 there is a stale read, not a missing image. The same `error` event also fires for a dropped connection, and discarding a live image over one lost packet can't be undone.
- `refresh()` and the 409 branch of `flushSave()` both adopt a remote blob only when its version is **strictly newer**. A stale read handing back the blob we just replaced would roll our own edits back, and an image reference lost that way gets its bytes deleted by the next write's diff. A 409 measured against a stale read isn't a real conflict, so the write stays pending and retries instead.
- An upload that finishes after its entry was deleted `DELETE`s its own image. That route refuses any id the live blob references _and_ any id older than an hour, so a stale blob read can't be used to talk it into deleting an established image.
- `imgCache` reuses one `<img>` element per id across renders, so the full-board repaint doesn't flash every picture. Responses are `immutable`-cached, since an id's bytes never change.

Pasting re-encodes through a canvas to max 1600px WebP (`encodeImage`), keeping whichever of the original/re-encode is smaller, and passing GIFs through untouched so animation survives. Server caps at 10 MB and accepts webp/png/jpeg/gif/avif.

`Entry.imageSize` is the natural `[w, h]`, recorded at upload (and backfilled on first load for older images). `.entry img.sized` reserves the box from it, so images never shift layout and the first-paint reveal does not wait on them. Cleared alongside `image` everywhere.

An entry with an image but no text is legal — clearing the field leaves the picture rather than silently destroying it. Deleting the image from a text-less entry removes the entry.

## Backups

A write that deletes a plan or list (`isDestructive`) first snapshots the blob it replaces into table `backups` (`at` = ms timestamp), pruned after 7 days. Restore by hand with the service stopped (it caches the blob), bumping the version so open clients' next save 409s and adopts it rather than looping:

```sh
sudo systemctl stop plan
sqlite3 plan.db "SELECT at, datetime(at/1000,'unixepoch','localtime') FROM backups"
sqlite3 plan.db "UPDATE data SET json = json_set((SELECT json FROM backups WHERE at = <at>), '\$.version', json_extract(json, '\$.version') + 1)"
sudo systemctl start plan
```

⚠️ Backups reference images that `reconcile` deletes on that same write. Restoring one will therefore bring back entries whose images are gone; `healBrokenImage` clears those references on first paint. Zero orphans was the explicit requirement and this is its cost.

## Security

- No auth: access control is the tailnet (see Stack).
- **Headers** (`harden()` in `server.ts`, on every response): a CSP on the page (scripts from self only, `frame-ancestors 'none'`), `nosniff`, `Referrer-Policy: no-referrer`, HSTS. Every `/api/` response without its own `Cache-Control` gets `no-store`. A new third-party script or frame needs adding to `CSP`.
- Static files are resolved under `dist/` and refused if the path escapes it.

## API

| Method   | Path            | Behavior                                                                                                                                                    |
| -------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET      | `/api/data`     | Return full blob (seeds on first read if missing)                                                                                                           |
| PUT      | `/api/data`     | Replace full blob (409 + current blob if `X-Plan-Version` is stale); enforces `Plan` plan exists; deletes newly-unreferenced images in the same transaction |
| POST     | `/api/img`      | Store an image body (≤10 MB, image types only) → `{ id }`                                                                                                   |
| GET/HEAD | `/api/img/<id>` | Fetch one image, immutably cached (HEAD = existence probe)                                                                                                  |
| DELETE   | `/api/img/<id>` | Drop one object; **409 if the live blob references it**                                                                                                     |

`GET /` is assembled by the server (`servePage`, via Bun's `HTMLRewriter`): the data blob is inlined as `<script id="boot" type="application/json">` (absent if the read failed — the client then fetches `/api/data`, retrying every 3s), and `styles.css`/`app.js` are linked as `?v=<content hash>` which the server serves `immutable` (the shell HTML and both hashes are computed once at startup, since only a new build changes them) — repeat loads download nothing and reuse the browser's compiled-code cache. Unsized images of the active plan and its background are preloaded (fonts are preloaded by `index.html` itself). The response is `no-store` (it carries private data). The client keeps `body` children `visibility: hidden` until `reveal()` (first render done, fonts loaded, unsized images decoded, capped at 1.5s), so the first painted frame is the final layout. Everything else is a file from `dist/` (`serveAsset`). `cacheControl()` in `server.ts` marks fonts and `Sortable.min.js` `immutable` for a year: **rename the file** when replacing one, or browsers keep the old copy.

## Client architecture (`public/app.js`)

Four concerns, in this order in the file:

1. **State + persistence** — `state.data` mirrors the server. `save()` throttles to one PUT per `SAVE_INTERVAL` (5s); `saveNow()` flushes immediately, used for destructive actions (deletes, undo, images, background).
2. **Render** — one `render()` rebuilds `<main>` from scratch each call. The data set is tiny; do not optimize prematurely.
3. **Modes** — `body.dataset.mode` is `"normal" | "insert" | "palette" | "confirm" | "image"` (the background dialog reuses `palette`). The desktop keyboard handler is a no-op in any non-`normal` mode.
   - **Undo** — `pushHistory()` deep-clones `state.data` + `selection` onto a 5-deep stack right before each mutating action; `undo()` (Ctrl+Z, normal mode only) pops and restores. Restored snapshots keep the live `state.data.version` so the next save doesn't 409. Abandoned creations (a new entry/list created then cancelled) pop their snapshot off `history`, so undo never replays a no-op. `applyRemote()` clears the stack — its snapshots are relative to the superseded blob.
4. **Drag** — SortableJS, two groups (`"lists"` horizontal, `"entries"` for items). Cross-list moves work in single view too: a drag starting there flips the board to multi view for its duration (`onStart` in `attachSortables`) and back on drop. Our own edge auto-scroll replaces Sortable's. Disabled while editing so text selection isn't hijacked. Desktop single view also cycles lists on an 80px+ horizontal mouse drag over empty board.

### Desktop key map (normal mode)

| Key               | Action                                                                                                                                                                                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ↑ / ↓ (`k` / `j`) | Move selection within the list. Up off the first entry selects the list header (`entryIndex = -1`); down off the last wraps to the first. From the header, ↓ goes to the first entry, ↑ to the last                                                                                                  |
| ← / → (`h` / `l`) | Switch to adjacent list; wraps at both ends, in both views                                                                                                                                                                                                                                           |
| Shift+↑/↓         | Reorder selected entry within its list (wraps)                                                                                                                                                                                                                                                       |
| Shift+←/→         | If an entry is selected: move it to the adjacent list. If the list is selected: swap the list with its neighbour. Both wrap                                                                                                                                                                          |
| Enter             | New entry below the selected one (at the top if the header is selected), in insert mode. Enter while editing a new entry: the first commits and stops, every following Enter in the same burst opens the next entry (`chainArmed`)                                                                   |
| Tab               | Toggle the selected entry as the list's todo (one per list)                                                                                                                                                                                                                                          |
| Delete/Backspace  | Delete selected entry, or — if the list itself is selected (`entryIndex = -1`) — delete the list. Skips the confirmation dialog when the list is empty.                                                                                                                                              |
| `n`               | New list (empty name, ready to type; Esc removes the empty list)                                                                                                                                                                                                                                     |
| `e`               | Edit current list name (or selected entry, if one is selected)                                                                                                                                                                                                                                       |
| `r`               | Delete current plan (confirm dialog; `Plan` is protected)                                                                                                                                                                                                                                            |
| `b`               | Set / clear background image URL for current plan                                                                                                                                                                                                                                                    |
| `Space`           | Plan palette — fuzzy match, Enter switches plan. Up/Down (or Shift+J/K) wraps. Shift+↑/↓ with an empty query reorders plans; `Plan` stays put. While a query is typed, a `<New plan>` row sits at the bottom which creates a plan named after the query and opens its first list's name for editing. |
| `v`               | Toggle multi-list / single-list view (desktop only)                                                                                                                                                                                                                                                  |
| `o`               | Open the selected entry's image in the full-screen preview                                                                                                                                                                                                                                           |
| Ctrl+V            | Attach a clipboard image to the selected entry (replaces any existing one). Also works while editing — that's how mobile attaches, via the long-press paste menu.                                                                                                                                    |
| Ctrl+Shift+V      | Remove the selected entry's image. Normal mode only, so it doesn't shadow paste-as-plain-text while editing. Not undoable.                                                                                                                                                                           |
| Ctrl+Z            | Undo the last mutating action (create/delete/edit/reorder/move/todo/bg). Up to 5 deep.                                                                                                                                                                                                               |
| Ctrl+C            | Copy the selected entry's text                                                                                                                                                                                                                                                                       |
| Esc               | Deselect the entry, keeping the list selected (modals handle their own close)                                                                                                                                                                                                                        |

### Mobile (detected via `matchMedia("(hover: none) and (pointer: coarse)")` OR a mobile UA regex; mirrored to `body.touch` so CSS gating survives Firefox/Zen UA spoofing)

- Defaults to single-list view (as does any window under 600px wide).
- Top bar (`#topbar`) is always visible on every device. On desktop it's a passive header showing the active plan name; `#m-view` is hidden and `#m-palette` has no click handler. On mobile both buttons are interactive — `#m-palette` opens the palette, `#m-view` toggles single/multi.
- The bottom action bar (`#actions`) is collapsed behind `#nav-toggle`, which toggles `body.nav-open`.
- Swipe to switch lists is gated to single-list view only. In multi-list view the touch scrolls the board naturally (no latching).
- Plan palette hides its search input on mobile (`body.touch #palette-input { display: none }`); the full list of plans is shown and tappable.
- Confirm-style dialogs render a `Confirm` submit button; hidden on desktop (Enter routes through `form.requestSubmit()`), visible on mobile.
- Tap empty space → deselect (single view drops only the entry selection, so the visible list stays; multi view clears both).
- **Touch while editing** (`insert` mode): a touch inside the active field places the caret / selects text; anything else commits the open field, and where it landed decides what follows — a **tap** on another entry or header **in the same list** opens the tapped one at the tapped spot (re-resolved by id via `editEntryById`/`editListById`, since the commit re-rendered the board); a tap anywhere else — another list, empty space — commits and deselects, like a background tap; a touch that **scrolled** commits and deselects without opening anything.
  - That decision can't be made when the finger lands (a touch on an entry is equally the start of a scroll), so `pointerdown` only _arms_ it — recording the tap point and the same-list target while the node is still live — and `touchend`/`touchcancel` decides by travel distance (>10px = a scroll). Committing on press instead re-renders the board out from under the gesture: the `<ul>` being scrolled is detached mid-scroll, so the list freezes and the entry under the finger opens. The end listeners are on `document` in the bubble phase, so the swipe handler on `board` runs first and still sees `insert` — a scroll that drifts sideways must not also switch lists.
  - A tap `swallowNextClick()`s so the post-commit trailing click can't misfire against a detached node; a scroll doesn't, since it fires no click and swallowing would eat the next tap. Non-touch pointers (a mouse on a touch-capable device) fire no `touchend`, so they decide on press.
- With nothing selected (`listIndex < 0`), **delete-list** removes the last active list on the plan and **toggle-view** lands on it, via `resolvedListIndex()` (falls back to the first list). `state.lastListIndex` is updated in `render()` whenever a real list is selected.
- Tap entry: selects it and opens it for editing, caret at the tapped spot. Soft-keyboard Enter while editing commits and always opens a fresh entry below (new or existing entry, edited or not), so the keyboard stays up; Enter on a blank field commits nothing and stops. The `chainable` flag threaded through `newEntryBelow`/`editEntry` marks the new-list flow, which chains on desktop too; otherwise desktop follows its own rule (see Enter above). Committing a **new list's name** starts the chain only when it's committed with Enter (`chainOnCommit` in `editList`) — tapping/clicking away just creates the list. A `chainable` chain ends when the field is committed by a blur that isn't from Enter — i.e. tapping outside — which returns to normal mode without spawning another entry. A touch anywhere outside the live edit field commits it on lift (and recovers to normal mode if `insert` is somehow set with no focused field), so a stray touch can't leave the board stuck in `insert`.
- Tap a list's header (`.list-name`) to select that list (`entryIndex = -1`) and edit its name.
- Bottom action bar exposes `del-plan`, `new-list`, `del-list`, `toggle-todo` (the last mirrors desktop `Tab` — mark/unmark the selected entry). New plans are created from the palette's `<New plan>` row, not the action bar.
- Tap an entry's image to open the preview. It fills the viewport over a faded backdrop and carries its own bottom bar (`#img-actions` — open in new tab / delete image), because the real `#actions` sits behind the dialog's backdrop. Tapping anywhere that isn't the picture or that bar closes it — `#img-view` needs its own close handler rather than `attachBackdropClose`, since the letterboxing around a contained image would otherwise hit the `<img>`, not the dialog. Desktop drives the same dialog with `Delete`/`Backspace`, `n` (new tab) and `Esc`.
- All modal dialogs close on backdrop tap. Anything that dismisses a modal on `pointerdown` (backdrop, palette rows via `fastTap`, `.confirm-btn`) calls `swallowNextClick()` so the trailing click doesn't fall through to the board behind it.

## Styling — `public/styles.css`

Nord palette is exposed as CSS custom properties (`--darkest1`..`--darkest4`, `--lightest1`/`--lightest3`, `--blue2`/`--blue3`; only the ones in use) plus semantic aliases (`--bg`, `--fg`, `--surface`, `--border`, `--accent`) and fonts (`--headerFont`, `--primaryFont`, `--ease`). Fonts (Hammersmith One + Sora) are self-hosted as `@font-face` rules pointing at `public/fonts/*.woff2` — served first-party, no Google Fonts dependency. Sora is a variable font, so one file covers weights 300–600. To update a font, re-pull the woff2 from Google's CSS (with a modern browser UA) and save it under a new filename (it is cached `immutable`), updating the `@font-face` and preload URLs.

The "no buttons on desktop" rule lives in CSS: `#actions`, `#nav-toggle`, `#img-actions` and `.confirm-btn` are `display: none` by default and only shown under `body.touch`. The top bar is the one exception — always shown, but inert on desktop.

If you find yourself adding a desktop button, you're doing it wrong — bind a key instead.

## Invariants

- The `Plan` plan always exists (server- and client-enforced).
- One render path. Single-view is a CSS state, not a code fork.
- Routine saves are throttled to one write per `SAVE_INTERVAL` ms (5s); `saveNow()` (deletes, undo, images, background) writes at once. `beforeunload` shows the native unsaved-changes prompt while a write or upload is pending.
- No image row survives that the blob doesn't reference. Enforced server-side on every write (`reconcile`) with a periodic `sweep` behind it; the client is never trusted to report a deletion.

## Dev loop

`bun run dev` builds and serves on `http://127.0.0.1:8787` with data in `./data/plan.db` (localhost counts as a secure context).
