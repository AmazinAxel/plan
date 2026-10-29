// Shared with the server, so the client never uploads what it would reject;
// build.ts bundles it in.
import { ALLOWED_TYPES, MAX_IMAGE_BYTES } from "../src/images.ts";

const $ = (id) => document.getElementById(id);
const body = document.body;
const board = $("board");

const state = {
  data: { activePlanId: "", plans: [] },
  selection: { listIndex: 0, entryIndex: -1 },
  isTouch: matchMedia("(hover: none) and (pointer: coarse)").matches
    || /Mobi|Android/i.test(navigator.userAgent),
  // Desktop: Enter on a freshly added entry saves-and-stops until the chain is
  // armed, which that same commit does — so the next Enter, and every one after
  // it, also opens the following entry. Disarmed by anything else (see keydown).
  chainArmed: false,
  // The most recent list index that was actually selected (>= 0). Used to fall
  // back to a sensible list when nothing is selected (delete-list / toggle-view).
  lastListIndex: 0
};

// Servo built without its webcrypto feature (flurry's sideview) has no `crypto`
// global; ids only need to be unique, so Math.random stands in there.
const uuid = () => globalThis.crypto?.randomUUID?.() ??
  "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (Math.random() * 16) >> (c / 4)).toString(16));
const wrap = (i, n) => ((i % n) + n) % n;
const isField = (el) => el?.tagName === "INPUT" || el?.tagName === "TEXTAREA";
const activePlan = () =>
  state.data.plans.find((p) => p.id === state.data.activePlanId) || state.data.plans[0];

// ---------- persistence ----------
// Throttled to one PUT per SAVE_INTERVAL ms; beforeunload guards a pending write.
const SAVE_INTERVAL = 5000;
let saveTimer = null;
let savePending = false;
let lastSaveAt = 0;

async function flushSave() {
  saveTimer = null;
  if (!savePending) return;
  savePending = false;
  lastSaveAt = Date.now();
  // Strip blank entries while serializing, so an in-progress edit survives in
  // memory. An entry carrying an image is never blank — the picture is its
  // content, and dropping it here would hide the reference from the server,
  // whose orphan diff would then delete an image the client is still showing.
  const json = JSON.stringify(state.data, (k, v) =>
    k === "entries" ? v.filter((e) => (e.text && e.text.trim()) || e.image) : v);
  const res = await fetch("/api/data", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Plan-Version": String(state.data.version ?? 0)
    },
    body: json
  });
  if (res.status === 409) {
    const remote = await res.json();
    // Another device wrote first; adopt its state instead of clobbering — but
    // only if it really is ahead of us. A rejection measured against a blob no
    // newer than ours isn't a real conflict; adopting it would undo our own
    // edits, so leave the write pending and try again.
    if (remote.version > (state.data.version ?? 0)) applyRemote(remote);
    else save();
    return;
  }
  if (res.ok) {
    const v = res.headers.get("X-Plan-Version");
    if (v) state.data.version = Number(v);
  }
}
function save() {
  scrubHistory();
  savePending = true;
  if (saveTimer) return;
  const wait = Math.max(0, SAVE_INTERVAL - (Date.now() - lastSaveAt));
  saveTimer = setTimeout(flushSave, wait);
}
function saveNow() {
  scrubHistory();
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  savePending = true;
  return flushSave();
}

// ---------- undo history ----------
// Snapshot state.data before each mutating action; Ctrl+Z restores the last one.
// The data blob is tiny, so a deep clone per action is cheap.
const HISTORY_LIMIT = 5;
const history = [];
function pushHistory() {
  history.push({
    data: structuredClone(state.data),
    selection: { ...state.selection }
  });
  if (history.length > HISTORY_LIMIT) history.shift();
}
// The server deletes an image the moment the blob stops referencing it, so a
// snapshot must never hold a reference the live data has dropped — undoing into
// one would restore a permanently broken image. Runs on every save, which is
// the only thing that can make an id unreferenced. The element cache is pruned
// on the same pass for the same reason.
function scrubHistory() {
  const live = liveImageIds();
  for (const snap of history) {
    eachEntry(snap.data, (e) => { if (e.image && !live.has(e.image)) { delete e.image; delete e.imageSize; } });
  }
  for (const id of imgCache.keys()) if (!live.has(id)) imgCache.delete(id);
  for (const id of objectUrls.keys()) {
    if (live.has(id)) continue;
    URL.revokeObjectURL(objectUrls.get(id));
    objectUrls.delete(id);
  }
}
function undo() {
  const prev = history.pop();
  if (!prev) return;
  // Keep the live server version so the next save doesn't 409 against a stale one.
  prev.data.version = state.data.version;
  state.data = prev.data;
  state.selection = prev.selection;
  saveNow(); render(); scrollSelectionIntoView();
}

// ---------- mode ----------
function setMode(mode) { body.dataset.mode = mode; }

// ---------- render ----------
// Mobile keyboards autocorrect a typed `--` into an em dash, which would make
// section headers untypable on a phone. Fold em/en dashes back to `--` on the
// way in so both spellings mean the same thing.
const undash = (s) => s.replace(/[—–]/g, "--");
const isSep = (s) => /^-{2,}(\s.*\s-{2,})?$/.test(s);

// Rendered nodes by list/entry id (see render()).
const listEls = new Map();
const entryEls = new Map();

function render() {
  const plan = activePlan();
  if (!plan) { board.innerHTML = ""; listEls.clear(); entryEls.clear(); return; }

  if (state.selection.listIndex >= plan.lists.length) state.selection.listIndex = Math.max(0, plan.lists.length - 1);
  const list = plan.lists[state.selection.listIndex];
  if (list && state.selection.entryIndex >= list.entries.length) state.selection.entryIndex = list.entries.length - 1;

  // Remember the last genuinely-selected list so we can fall back to it when the
  // selection is cleared (delete-list with nothing active, toggle-view, etc.).
  if (state.selection.listIndex >= 0) state.lastListIndex = state.selection.listIndex;
  // Preserve per-list scroll positions for any section that has to move. Read
  // before any write, so this never forces a layout.
  const scrolls = {};
  listEls.forEach((el, id) => { scrolls[id] = el.lastChild.scrollTop; });
  const boardScrollLeft = board.scrollLeft;
  let moved = false;
  // Lists and entries are reconciled by id against what's already on screen and
  // only what differs is touched — a selection move flips two attributes. Every
  // DOM call costs (Servo especially: each is a binding crossing, each write
  // dirties layout), and brand-new scrollers there apply scrollTop a frame late
  // (selection painted before the list scrolled to it). Nodes are looked up in
  // JS maps, not queried; `_k`/`_f`/`_sel`/`_items` cache what a node last
  // rendered (editors that hollow a node out reset `_k`).
  const oldLists = new Map(listEls);
  const oldEntries = new Map(entryEls);
  listEls.clear(); entryEls.clear();
  plan.lists.forEach((l, li) => {
    let el = oldLists.get(l.id);
    oldLists.delete(l.id);
    if (!el) {
      el = document.createElement("section");
      el.className = "list";
      el.dataset.listId = l.id;
      const name = document.createElement("div");
      name.className = "list-name";
      name.dataset.role = "list-name";
      const ul = document.createElement("ul");
      ul.className = "entries";
      ul.dataset.listId = l.id;
      el.append(name, ul);
    }
    listEls.set(l.id, el);
    const sel = li === state.selection.listIndex;
    const f = sel ? state.selection.entryIndex : null;
    if (el._f !== f) {
      el.toggleAttribute("data-selected", sel);
      el.toggleAttribute("data-active", sel);
      el.toggleAttribute("data-list-selected", sel && f === -1);
      el.toggleAttribute("data-first-selected", sel && f === 0);
      el._f = f;
    }

    const name = el.firstChild, ul = el.lastChild;
    if (name._k !== l.name) { name.textContent = l.name; name._k = l.name; }
    const kids = ul._items ?? [];
    let same = kids.length === l.entries.length;
    const items = l.entries.map((e, ei) => {
      let it = oldEntries.get(e.id);
      if (!it) {
        it = document.createElement("li");
        it.className = "entry";
        it.dataset.entryId = e.id;
      }
      entryEls.set(e.id, it);
      const k = `${e.text}\n${e.image}\n${e.imageSize}\n${e.todo}`;
      if (it._k !== k) {
        it.textContent = e.text;
        // Appended after the text, so `it.firstChild` stays the text node that
        // caretOffsetFromPoint measures against.
        if (e.image) it.appendChild(imgFor(e.image, e.imageSize));
        it.toggleAttribute("data-sep", isSep(e.text));
        it.toggleAttribute("data-todo", !!e.todo);
        it._k = k;
      }
      const on = sel && ei === state.selection.entryIndex;
      if (it._sel !== on) { it.toggleAttribute("data-selected", on); it._sel = on; }
      if (kids[ei] !== it) same = false;
      return it;
    });
    // Compared against what we last rendered, not the live children: a drag
    // moves nodes behind our back, and its onEnd re-renders the new order anyway.
    if (!same) ul.replaceChildren(...items);
    ul._items = items;
    // Only move a section that's out of place; detaching drops its scroll offset.
    const at = board.children[li];
    if (at !== el) {
      moved = true;
      board.insertBefore(el, at ?? null);
      if (scrolls[l.id] != null) ul.scrollTop = scrolls[l.id];
    }
  });
  oldLists.forEach((s) => s.remove());
  if (moved) board.scrollLeft = boardScrollLeft;

  renderDots(plan);
  attachSortables();
  const title = plan.name || "—";
  if ($("m-plan-name").textContent !== title) $("m-plan-name").textContent = title;
  const isDefault = plan.name === "Plan";
  if ($("m-del-plan").hidden !== isDefault) $("m-del-plan").hidden = isDefault;
  const docTitle = !plan.name ? "plan" : isDefault ? "Plan" : `${plan.name} plan`;
  if (document.title !== docTitle) document.title = docTitle;
  showBackground(plan.background);
}

// A plan change drops the old background at once. A loaded one goes straight in;
// one still loading appears, once decoded, under a plain cover that fades out.
// Only the cover animates (its color; see .bg.out): fading the image itself
// flickered in WebKit. One <img>
// per URL is kept for the session, and preloadBackgrounds() fills it, so
// switching plans is normally instant.
const bgImgs = new Map();
let shownBg;

function bgImg(url) {
  if (!bgImgs.has(url)) {
    // sync: WebKit otherwise paints a blank frame while it decodes at paint time.
    const img = Object.assign(document.createElement("img"), { className: "bg", alt: "", decoding: "sync", src: url });
    // Settles once loaded, and decoded where the browser manages it (WebKit's
    // decode() can reject an image that loaded fine). A failed one is dropped so
    // the next visit retries.
    img.ready = new Promise((r) => { img.onload = img.onerror = r; })
      .then(() => img.decode()).catch(() => {})
      .then(() => { if (!img.naturalWidth) bgImgs.delete(url); });
    bgImgs.set(url, img);
  }
  return bgImgs.get(url);
}

function preloadBackgrounds() {
  for (const p of state.data.plans) if (p.background) bgImg(p.background);
}

function showBackground(bg) {
  if (bg === shownBg) return;
  shownBg = bg;
  document.querySelectorAll(".bg").forEach((el) => el.remove());
  if (!bg) return;
  const img = bgImg(bg);
  if (img.complete && img.naturalWidth) return void body.prepend(img);
  img.ready.then(() => {
    if (shownBg !== bg || !img.naturalWidth || img.isConnected) return;
    const cover = Object.assign(document.createElement("div"), { className: "bg out" });
    cover.addEventListener("animationend", () => cover.remove(), { once: true });
    body.prepend(img, cover);
  });
}

function renderDots(plan) {
  const dots = $("dots");
  const n = plan.lists.length > 1 ? plan.lists.length : 0;
  dots.hidden = !n;
  while (dots.children.length > n) dots.lastChild.remove();
  while (dots.children.length < n) dots.appendChild(document.createElement("span"));
  [...dots.children].forEach((d, i) => d.toggleAttribute("data-active", i === state.selection.listIndex));
}

// ---------- sortable ----------
// One Sortable per element, kept across renders (render() reuses the board and
// each list's <ul>); attachSortables() adds them for new lists and drops gone ones.
const sortables = new Map();
// Toggle dragging on all sortables. Disabled while editing so a mouse-drag to
// select text inside the field isn't hijacked into an entry/list drag (which
// also left the board in a glitched, unselectable state on abort). Ending an
// edit calls render(), which re-enables them.
function setDragEnabled(on) { sortables.forEach((s) => s.option("disabled", !on)); }

// Auto-scroll a list while dragging an entry near its top/bottom edge. Works for
// both desktop (native drag -> dragover) and touch (Sortable fallback -> touchmove).
const autoScroll = { active: false, raf: 0, x: 0, y: 0 };
// Speed for a pointer at `v` inside [lo, hi]: ramps up to `max` px/frame across
// an edge zone, zero in the middle.
function edgeSpeed(v, lo, hi, zone, max) {
  if (v < lo + zone) return -max * ((lo + zone - v) / zone);
  if (v > hi - zone) return max * ((v - (hi - zone)) / zone);
  return 0;
}
const inside = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
function autoScrollTrack(e) {
  const t = e.touches?.[0] || e.changedTouches?.[0] || e;
  if (t.clientX != null) { autoScroll.x = t.clientX; autoScroll.y = t.clientY; }
}
function autoScrollStep() {
  if (!autoScroll.active) return;
  const { x, y } = autoScroll;
  // Horizontal board scroll near its left/right edges (8%, min 40px). Reveals the
  // neighbouring lists while dragging a list, or an entry across lists.
  const b = board.getBoundingClientRect();
  if (inside(b, x, y)) board.scrollLeft += edgeSpeed(x, b.left, b.right, Math.max(40, b.width * 0.08), 20);
  // Vertical scroll within whichever list the pointer is hovering (10%, min 24px).
  board.querySelectorAll(".entries").forEach((ul) => {
    const r = ul.getBoundingClientRect();
    if (inside(r, x, y)) ul.scrollTop += edgeSpeed(y, r.top, r.bottom, Math.max(24, r.height * 0.1), 14);
  });
  autoScroll.raf = requestAnimationFrame(autoScrollStep);
}
function startAutoScroll() {
  if (autoScroll.active) return;
  autoScroll.active = true;
  document.addEventListener("dragover", autoScrollTrack, true);
  document.addEventListener("touchmove", autoScrollTrack, { capture: true, passive: true });
  document.addEventListener("pointermove", autoScrollTrack, true);
  autoScroll.raf = requestAnimationFrame(autoScrollStep);
}
function stopAutoScroll() {
  if (!autoScroll.active) return;
  autoScroll.active = false;
  cancelAnimationFrame(autoScroll.raf);
  document.removeEventListener("dragover", autoScrollTrack, true);
  document.removeEventListener("touchmove", autoScrollTrack, { capture: true });
  document.removeEventListener("pointermove", autoScrollTrack, true);
}
function attachSortables() {
  // Sortable loads async (see index.html); its load handler calls back in here.
  if (!activePlan() || !window.Sortable) return;
  sortables.forEach((s, el) => { if (!el.isConnected) { s.destroy(); sortables.delete(el); } });
  setDragEnabled(true);

  // Shared by the list sortable and the entry sortables. In single view,
  // body.dragging makes the CSS reveal every list for the drag's duration (so a
  // dragged list/entry has somewhere to go) and hide them again on drop; all
  // that's left here is keeping the grabbed list where it was, centred.
  const onStart = () => {
    body.classList.add("dragging");
    startAutoScroll();
    if (body.dataset.view !== "single") return;
    listEls.get(activePlan().lists[state.selection.listIndex]?.id)
      ?.scrollIntoView({ behavior: "instant", inline: "center", block: "nearest" });
  };
  const endDrag = () => {
    body.classList.remove("dragging");
    stopAutoScroll();
  };
  if (!sortables.has(board)) sortables.set(board, Sortable.create(board, {
    group: "lists",
    animation: 120,
    draggable: ".list",
    filter: ".entries, .list-name input",
    preventOnFilter: false,
    onStart,
    onEnd: (ev) => {
      endDrag();
      if (ev.oldIndex === ev.newIndex) return;
      pushHistory();
      const plan = activePlan();
      plan.lists.splice(ev.newIndex, 0, ...plan.lists.splice(ev.oldIndex, 1));
      state.selection.listIndex = ev.newIndex;
      save(); render();
    }
  }));

  board.querySelectorAll(".entries").forEach((ul) => {
    if (!sortables.has(ul)) sortables.set(ul, Sortable.create(ul, {
      // Cross-list moves stay enabled even in single view: the drag reveals the
      // neighbouring lists (see onStart) so an entry can be dropped
      // into any of them.
      group: "entries",
      animation: 120,
      draggable: ".entry",
      scroll: false, // handled by our own edge auto-scroll (startAutoScroll)
      // Touch: brief hold before drag, so a quick swipe scrolls instead.
      delay: 250,
      delayOnTouchOnly: true,
      touchStartThreshold: 5,
      onStart,
      onEnd: (ev) => {
        endDrag();
        const plan = activePlan();
        const fromList = plan.lists.find((l) => l.id === ev.from.dataset.listId);
        const toList = plan.lists.find((l) => l.id === ev.to.dataset.listId);
        if (!fromList || !toList || (fromList === toList && ev.oldIndex === ev.newIndex)) return;
        pushHistory();
        toList.entries.splice(ev.newIndex, 0, ...fromList.entries.splice(ev.oldIndex, 1));
        state.selection.listIndex = plan.lists.indexOf(toList);
        state.selection.entryIndex = ev.newIndex;
        save(); render();
      }
    }));
  });
}

// ---------- editing ----------
// Map a viewport point to a character offset within an entry's text, so a
// click/tap lands the caret where the finger/cursor was. Returns null when the
// point isn't over the entry's text (empty space) — callers fall back to end.
function caretOffsetFromPoint(x, y, entryEl) {
  let node = null, offset = null;
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos) { node = pos.offsetNode; offset = pos.offset; }
  } else if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    if (range) { node = range.startContainer; offset = range.startOffset; }
  }
  if (node && node.nodeType === Node.TEXT_NODE && entryEl.contains(node)) return offset;

  // WebKit (mobile Safari) returns null for a point inside an element with
  // user-select:none — which every .entry is — so the native hit-test above
  // always fails on touch and the caller falls back to end-of-text. Recover by
  // measuring the text node's per-character rects and picking the caret gap
  // nearest the tap. Works regardless of user-select.
  const text = entryEl.firstChild;
  if (!text || text.nodeType !== Node.TEXT_NODE || !text.textContent) return null;
  const range = document.createRange();
  const len = text.textContent.length;
  // Servo has neither hit-test above and answers this with whole-element boxes
  // instead of glyph boxes; skipping anything no glyph could be leaves no
  // match there, so the caret falls back to the end rather than the start.
  const half = entryEl.clientWidth / 2;
  let best = null, bestDist = Infinity;
  for (let i = 0; i < len; i++) {
    range.setStart(text, i);
    range.setEnd(text, i + 1);
    for (const r of range.getClientRects()) {
      if (r.width > half) continue;
      // Heavily penalise rects on other wrapped lines so the tap stays on its row.
      const offLine = (y < r.top || y > r.bottom) ? 1e6 : 0;
      const dLeft = Math.abs(x - r.left) + offLine;   // caret before this char
      const dRight = Math.abs(x - r.right) + offLine;  // caret after this char
      if (dLeft < bestDist) { bestDist = dLeft; best = i; }
      if (dRight < bestDist) { bestDist = dRight; best = i + 1; }
    }
  }
  return best;
}

// If focus leaves the window while editing, defer the commit until it returns
// rather than dropping the in-flight text.
function keepFocusOnTabSwitch(input) {
  const onBlur = (e) => {
    if (document.hasFocus()) return; // real interactive blur — let the commit handler run
    e.stopImmediatePropagation();
    const onFocus = () => {
      window.removeEventListener("focus", onFocus);
      if (body.dataset.mode === "insert") input.focus();
    };
    window.addEventListener("focus", onFocus);
  };
  input.addEventListener("blur", onBlur, true); // capture-phase: runs before commit
  return () => input.removeEventListener("blur", onBlur, true);
}

function editList(listIndex, isNew = false) {
  const plan = activePlan();
  const list = plan.lists[listIndex];
  if (!list) return;
  setMode("insert");
  setDragEnabled(false);
  const nameEl = listEls.get(list.id).firstChild;
  nameEl.textContent = "";
  nameEl._k = null;
  const input = document.createElement("input");
  input.value = list.name;
  nameEl.appendChild(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  const stopKeep = keepFocusOnTabSwitch(input);
  // Only flow into entry creation when the name was committed with Enter
  // ("keep going"); committing by tapping/clicking away just creates the list.
  let chainOnCommit = false;
  const commit = () => {
    stopKeep();
    const v = input.value.trim();
    if (!isNew && v !== list.name) pushHistory();
    list.name = v;
    save();
    setMode("normal"); render();
    if (chainOnCommit && list.entries.length === 0) newEntryBelow(isNew);
  };
  const cancel = () => {
    stopKeep();
    if (isNew && !list.name && list.entries.length === 0) {
      plan.lists.splice(listIndex, 1);
      state.selection.entryIndex = -1;
      history.pop(); // discard the snapshot newList() pushed for this abandoned list
      save();
    }
    setMode("normal"); render();
  };
  let cancelled = false;
  input.addEventListener("blur", () => { if (!cancelled) commit(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); chainOnCommit = true; input.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); cancelled = true; cancel(); }
    e.stopPropagation();
  });
}

function editEntry(listIndex, entryIndex, isNew = false, caretPos = null, chainable = false) {
  const plan = activePlan();
  const list = plan.lists[listIndex];
  const entry = list?.entries[entryIndex];
  if (!entry) return;
  setMode("insert");
  setDragEnabled(false);
  const it = entryEls.get(entry.id);
  // Only the text is replaced by the field — an attached image stays visible
  // while its entry is being edited.
  const img = it.querySelector("img");
  it.textContent = "";
  it._k = null;
  const input = document.createElement("textarea");
  input.value = entry.text;
  input.rows = 1;
  it.appendChild(input);
  if (img) it.appendChild(img);
  const resize = () => { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; };
  // Separator styling follows the field as you type, instead of appearing only
  // after the commit re-renders. Just an attribute flip on the <li> already in
  // the DOM — no re-render, no measurable cost.
  const syncSep = () => { it.toggleAttribute("data-sep", isSep(undash(input.value.trim()))); };
  input.addEventListener("input", () => { resize(); syncSep(); });
  resize();
  syncSep();
  input.focus();
  const caret = caretPos ?? input.value.length;
  input.setSelectionRange(caret, caret);
  const stopKeep = keepFocusOnTabSwitch(input);
  let cancelled = false;
  let chain = false;
  let armsChain = false;
  const commit = () => {
    stopKeep();
    const v = undash(input.value.trim());
    if (isNew) { if (!v && !entry.image) history.pop(); } // abandoned new entry — discard its snapshot
    else if (v !== entry.text) pushHistory();
    if (v) entry.text = v;
    // An entry that carries an image survives an empty field — the picture is
    // the content. Splicing it would destroy the image along with it.
    else if (entry.image) entry.text = "";
    else list.entries.splice(entryIndex, 1);
    save();
    setMode("normal"); render();
    // Keep the chain alive across spawned entries so the new-list flow keeps
    // making entries on each Enter until the field is committed by tapping out.
    if (chain && v) newEntryBelow(chainable);
    // Desktop: this Enter only armed the chain (see keydown) — the next one starts
    // it. Anything else (tapping out, an empty entry, editing an existing one)
    // ends the burst.
    else if (armsChain && v) state.chainArmed = true;
    else state.chainArmed = false;
  };
  input.addEventListener("blur", () => { if (!cancelled) commit(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // Desktop: only new entries chain, and only once the chain is armed — the
      // first Enter-committed entry in a burst saves-and-stops, every one after
      // that chains. Mobile: Enter always opens the next entry so the keyboard
      // stays up; Enter on a blank field or tapping outside ends the run. The
      // new-list flow (chainable) always keeps going on either platform.
      chain = chainable || state.isTouch || (isNew && state.chainArmed);
      armsChain = !chainable && !state.isTouch && isNew && !state.chainArmed;
      input.blur();
    }
    else if (e.key === "Escape") {
      e.preventDefault(); cancelled = true; stopKeep(); state.chainArmed = false;
      if (!entry.text && !entry.image) { list.entries.splice(entryIndex, 1); if (isNew) history.pop(); save(); }
      setMode("normal"); render();
    }
    e.stopPropagation();
  });
}

// ---------- actions ----------
function newList() {
  const plan = activePlan();
  pushHistory();
  plan.lists.push({ id: uuid(), name: "", entries: [] });
  state.selection.listIndex = plan.lists.length - 1;
  state.selection.entryIndex = -1;
  save();
  render();
  editList(state.selection.listIndex, true);
}

// `chainable` carries the new-list flow: every Enter keeps spawning another
// entry (see editEntry) until the field is committed by tapping outside.
function newEntryBelow(chainable = false) {
  const plan = activePlan();
  const list = plan.lists[state.selection.listIndex];
  if (!list) return;
  pushHistory();
  // List itself selected (entryIndex -1): insert at the top, not the bottom.
  const at = state.selection.entryIndex >= 0 ? state.selection.entryIndex + 1 : 0;
  const entry = { id: uuid(), text: "" };
  list.entries.splice(at, 0, entry);
  state.selection.entryIndex = at;
  save();
  render();
  editEntry(state.selection.listIndex, at, true, null, chainable);
}

function toggleTodo() {
  const { list, entry } = selected() || {};
  if (!entry) return;
  pushHistory();
  if (entry.todo) {
    delete entry.todo;
  } else {
    // Only one todo per list.
    list.entries.forEach((x) => { delete x.todo; });
    entry.todo = true;
  }
  save(); render();
}

function deleteEntry() {
  const { list } = selected() || {};
  if (!list) return;
  pushHistory();
  list.entries.splice(state.selection.entryIndex, 1);
  saveNow(); render();
}

function deleteCurrentPlan() {
  const plan = activePlan();
  if (!plan || plan.name === "Plan") return; // the default plan is protected
  confirmModal(`delete plan "${plan.name || "—"}"?`, () => {
    pushHistory();
    state.data.plans = state.data.plans.filter((p) => p.id !== plan.id);
    state.data.activePlanId = state.data.plans[0].id;
    state.selection = { listIndex: 0, entryIndex: -1 };
    saveNow(); render();
  });
}

// When nothing is selected (listIndex < 0), fall back to the last active list on
// this plan, clamped to what still exists — or the first list if none was set.
function resolvedListIndex() {
  const plan = activePlan();
  if (!plan || plan.lists.length === 0) return -1;
  if (state.selection.listIndex >= 0) return state.selection.listIndex;
  return Math.min(Math.max(0, state.lastListIndex), plan.lists.length - 1);
}

function deleteCurrentList() {
  const plan = activePlan();
  // With no list selected, delete the last active list on this plan.
  if (state.selection.listIndex < 0) state.selection.listIndex = resolvedListIndex();
  const list = plan.lists[state.selection.listIndex];
  if (!list) return;
  const doDelete = () => {
    pushHistory();
    plan.lists.splice(state.selection.listIndex, 1);
    state.selection.entryIndex = -1;
    saveNow(); render();
  };
  if (list.entries.length === 0) { doDelete(); return; }
  confirmModal(`delete list "${list.name || "—"}"?`, doDelete);
}

// Flip single/multi view. If nothing is selected, land on the last active list
// (or the first) so single view always has a list to show instead of a blank
// board.
function toggleView() {
  if (state.selection.listIndex < 0) state.selection.listIndex = resolvedListIndex();
  body.dataset.view = body.dataset.view === "single" ? "multi" : "single";
  render();
}

// ---------- navigation ----------
// entryIndex === -1 means the list itself is selected (not any entry).
function move(dx, dy) {
  const plan = activePlan();
  if (!plan || plan.lists.length === 0) return;
  // Recover from the fully-deselected state (nothing selected): the first arrow
  // re-selects the first list's header.
  if (state.selection.listIndex < 0) {
    state.selection.listIndex = 0;
    state.selection.entryIndex = -1;
    render(); scrollSelectionIntoView();
    return;
  }
  // Lists wrap at both ends, in both views; render() clamps the entry index.
  if (dx) state.selection.listIndex = wrap(state.selection.listIndex + dx, plan.lists.length);
  if (dy) {
    const n = plan.lists[state.selection.listIndex].entries.length;
    const ei = state.selection.entryIndex;
    // From the header: up jumps to the last entry, down to the first. Up off the
    // first entry selects the header; down off the last wraps to the top.
    state.selection.entryIndex = !n ? -1 : ei === -1 ? (dy > 0 ? 0 : n - 1) : ei + dy >= n ? 0 : ei + dy;
  }
  render();
  scrollSelectionIntoView();
}

// shift+arrow: reorder the selected entry (or list if no entry is selected).
function shiftMove(dx, dy) {
  // Everything wraps past the ends, in both views.
  const plan = activePlan();
  const li = state.selection.listIndex, ei = state.selection.entryIndex;
  const list = plan?.lists[li];
  if (!list) return;
  const n = dy ? list.entries.length : plan.lists.length;
  if (n < 2 || (dy && ei < 0)) return;
  pushHistory();
  if (dy) {
    const ni = wrap(ei + dy, n);
    list.entries.splice(ni, 0, ...list.entries.splice(ei, 1));
    state.selection.entryIndex = ni;
  } else if (ei >= 0) {
    const ti = wrap(li + dx, n);
    const target = plan.lists[ti];
    const at = Math.min(ei, target.entries.length);
    target.entries.splice(at, 0, ...list.entries.splice(ei, 1));
    state.selection.listIndex = ti;
    state.selection.entryIndex = at;
  } else {
    const ni = wrap(li + dx, n);
    [plan.lists[li], plan.lists[ni]] = [plan.lists[ni], plan.lists[li]];
    state.selection.listIndex = ni;
  }
  save(); render(); scrollSelectionIntoView();
}

// Gap kept between a list and the board edge when scrolling it into view, so a
// keyboard-selected list at either end never sits flush against the viewport.
const EDGE_PAD = 16;

function scrollSelectionIntoView() {
  // Both axes are scrolled by assigning scrollLeft/scrollTop directly rather
  // than with scrollIntoView: that method walks every ancestor scroller, so
  // centering an entry vertically also nudged #board horizontally, which read
  // as the whole view jittering left/right on an up/down keypress.
  // All measuring happens before any scroll is written: a read after a write
  // forces a second full reflow (expensive in Servo).
  let left, top;
  const list = activePlan()?.lists[state.selection.listIndex];
  const sec = list && listEls.get(list.id);
  if (sec) {
    const bRect = board.getBoundingClientRect();
    const sRect = sec.getBoundingClientRect();
    const x = board.scrollLeft + (sRect.left - bRect.left);
    const max = board.scrollWidth - board.clientWidth;
    let target = board.scrollLeft;
    // Only scroll when the list actually pokes past an edge (inline: "nearest"
    // semantics), otherwise a vertical move would drag the board sideways.
    if (sRect.left - bRect.left < EDGE_PAD) target = x - EDGE_PAD;
    else if (sRect.right - bRect.left > board.clientWidth - EDGE_PAD)
      target = x - board.clientWidth + sec.offsetWidth + EDGE_PAD;
    left = Math.max(0, Math.min(max, target));
    if (left === board.scrollLeft) left = undefined;
  }
  const entry = list?.entries[state.selection.entryIndex];
  const sel = entry && entryEls.get(entry.id);
  const scroller = sel && sec.lastChild;
  if (scroller) {
    const sRect = scroller.getBoundingClientRect();
    const eRect = sel.getBoundingClientRect();
    const target = scroller.scrollTop + (eRect.top - sRect.top) - (scroller.clientHeight / 2) + (eRect.height / 2);
    const max = scroller.scrollHeight - scroller.clientHeight;
    top = Math.max(0, Math.min(max, target));
    if (Math.abs(top - scroller.scrollTop) < 1) top = undefined;
  }
  if (left !== undefined) board.scrollLeft = left;
  if (top !== undefined) scroller.scrollTop = top;
}

// ---------- modals ----------
// A touch modal closes on pointerdown (see below), but the browser still
// delivers the trailing click to whatever is now under the finger — the board
// behind the dialog — which would open the entry that sat behind the tapped
// item. Swallow exactly one following click (capture phase) to stop that
// pass-through. Times out in case no click ever arrives.
function swallowNextClick() {
  const onClick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    cleanup();
  };
  const cleanup = () => { window.removeEventListener("click", onClick, true); clearTimeout(timer); };
  const timer = setTimeout(cleanup, 700);
  window.addEventListener("click", onClick, true);
}

// Close on pointerdown, not click, so the dialog dismisses the instant a finger
// touches the backdrop rather than waiting for the synthetic click on release.
function attachBackdropClose(dlg) {
  dlg.addEventListener("pointerdown", (e) => {
    if (e.target !== dlg) return;
    if (state.isTouch) swallowNextClick();
    dlg.close();
  });
}

// Activate on pointerdown so a tapped item (e.g. a plan in the palette) fires the
// instant the finger lands — no wait for the synthetic click on release and no
// tap-highlight flash, so the modal just vanishes on press. preventDefault stops
// the trailing click from firing the handler a second time. Falls back to click
// off touch.
function fastTap(el, fn) {
  if (!state.isTouch) { el.addEventListener("click", fn); return; }
  el.addEventListener("pointerdown", (e) => { e.preventDefault(); swallowNextClick(); fn(e); });
}

function confirmModal(text, onYes) {
  const dlg = $("confirm");
  const form = $("confirm-form");
  $("confirm-text").textContent = text;
  setMode("confirm");
  let confirmed = false;
  const ac = new AbortController();
  const signal = ac.signal;
  form.addEventListener("submit", (e) => { e.preventDefault(); confirmed = true; dlg.close(); }, { signal });
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); form.requestSubmit(); }
  }, { signal });
  dlg.addEventListener("close", () => {
    ac.abort();
    if (confirmed) onYes();
    setMode("normal");
  }, { signal });
  dlg.showModal();
}

function fuzzyMatch(query, name) {
  query = query.toLowerCase(); name = name.toLowerCase();
  let qi = 0;
  for (let i = 0; i < name.length && qi < query.length; i++) if (name[i] === query[qi]) qi++;
  return qi === query.length;
}

function openPalette() {
  const dlg = $("palette");
  const input = $("palette-input");
  const list = $("palette-list");
  input.value = "";
  // On the default "Plan", start on the second row; elsewhere start on "Plan".
  const defaultIndex = state.data.plans.findIndex((p) => p.name === "Plan");
  let highlighted = activePlan().name === "Plan" ? 1 : Math.max(0, defaultIndex);
  setMode("palette");

  const matching = () => state.data.plans.filter((p) => !input.value || fuzzyMatch(input.value, p.name));
  // "<New plan>" is appended after all matches, at index matches.length, but
  // only while a query is typed.
  const showNew = () => !!input.value.trim();
  const count = () => matching().length + (showNew() ? 1 : 0);
  const refresh = () => {
    const matches = matching();
    const total = count();
    if (highlighted >= total) highlighted = Math.max(0, total - 1);
    list.innerHTML = "";
    matches.forEach((p, i) => {
      const li = document.createElement("li");
      li.textContent = p.name || "—";
      li.dataset.planId = p.id;
      if (p.name === "Plan") li.dataset.default = "";
      if (i === highlighted) li.dataset.active = "";
      fastTap(li, () => pick(p.id));
      list.appendChild(li);
    });
    if (!showNew()) return;
    const newLi = document.createElement("li");
    newLi.textContent = "<New plan>";
    if (highlighted === matches.length) newLi.dataset.active = "";
    fastTap(newLi, createNew);
    list.appendChild(newLi);
  };

  const pick = (planId) => {
    state.data.activePlanId = planId;
    state.selection = { listIndex: 0, entryIndex: -1 };
    save();
    ac.abort(); dlg.close(); setMode("normal"); render();
  };

  const createNew = () => {
    pushHistory();
    const p = { id: uuid(), name: input.value.trim(), lists: [{ id: uuid(), name: "", entries: [] }] };
    state.data.plans.push(p);
    pick(p.id);
    editList(0, true);
  };

  // Shift+Up/Down reorders the highlighted plan. Only with an empty query, so
  // "the row above" is unambiguously the plan above it in state.data.plans.
  // "Plan" is fixed and nothing swaps across it; "<New plan>" sits one past the
  // end of plans, so an out-of-range neighbour refuses the move on its own.
  const reorder = (dir) => {
    const plans = state.data.plans;
    const i = highlighted, j = highlighted + dir;
    if (input.value || !plans[i] || !plans[j] || plans[i].name === "Plan" || plans[j].name === "Plan") return;
    pushHistory();
    [plans[i], plans[j]] = [plans[j], plans[i]];
    highlighted = j;
    save();
    refresh();
  };

  const ac = new AbortController();
  const signal = ac.signal;
  input.addEventListener("keydown", (e) => {
    const matches = matching();
    const total = count();
    const down = e.key === "ArrowDown" || e.key === "J";
    const up = e.key === "ArrowUp" || e.key === "K";
    if (e.key === " " && !input.value) { e.preventDefault(); dlg.close(); }
    else if (e.shiftKey && (down || up)) { e.preventDefault(); reorder(down ? 1 : -1); }
    else if ((down || up) && total) {
      e.preventDefault();
      highlighted = wrap(highlighted + (down ? 1 : -1), total);
      refresh();
    }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (showNew() && highlighted === matches.length) createNew();
      else if (matches[highlighted]) pick(matches[highlighted].id);
    }
  }, { signal });
  input.addEventListener("input", () => { highlighted = 0; refresh(); }, { signal });
  dlg.addEventListener("close", () => { ac.abort(); if (body.dataset.mode === "palette") setMode("normal"); }, { signal });
  refresh();
  dlg.showModal();
  input.focus();
}

function openBg() {
  const plan = activePlan();
  if (!plan) return;
  const dlg = $("bg");
  const input = $("bg-input");
  const form = $("bg-form");
  input.value = plan.background || "";
  setMode("palette");
  let confirmed = false;
  const submit = () => {
    const v = input.value.trim();
    if (v !== (plan.background || "")) pushHistory();
    if (v) plan.background = v; else delete plan.background;
    confirmed = true;
    saveNow();
    dlg.close();
  };
  const ac = new AbortController();
  const signal = ac.signal;
  form.addEventListener("submit", (e) => { e.preventDefault(); submit(); }, { signal });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }, { signal });
  dlg.addEventListener("close", () => {
    ac.abort();
    setMode("normal");
    if (confirmed) render();
  }, { signal });
  dlg.showModal();
  input.focus();
}

// ---------- images ----------
// One image per entry. The blob stores only an id; the bytes live server-side behind
// /api/img. The server owns deletion — it diffs every write and drops whatever
// the new blob no longer references — so the client's whole job is to keep the
// reference honest and never resurrect a dead one (see scrubHistory).
const IMG_MAX_DIM = 1600;
const imgUrl = (id) => `/api/img/${id}`;

// render() rebuilds an entry's contents whenever its text changes, and a plan
// switch rebuilds its lists; reusing the same <img> element per id means that
// re-parents an already-decoded image instead of creating a fresh one that
// flashes while the browser re-reads its cache.
const imgCache = new Map();
const healing = new Set();
let uploads = 0;

// Blob URLs for images uploaded in this session. Rendering from the bytes we
// already have in hand skips a network round-trip, and doubles as proof (see
// healBrokenImage) that these ids exist no matter what a read says.
const objectUrls = new Map();
const imgSrc = (id) => objectUrls.get(id) || imgUrl(id);

function eachEntry(data, fn) {
  for (const plan of data?.plans || []) {
    for (const list of plan.lists || []) {
      for (const entry of list.entries || []) fn(entry, list, plan);
    }
  }
}

function liveImageIds() {
  const ids = new Set();
  eachEntry(state.data, (e) => { if (e.image) ids.add(e.image); });
  return ids;
}

// Resolve by id, not index: an upload finishes long after the paste, by which
// point the board may have been re-rendered, reordered, or switched plans.
function findEntry(listId, entryId) {
  for (const plan of state.data.plans || []) {
    for (const list of plan.lists || []) {
      if (list.id !== listId) continue;
      const entry = list.entries.find((x) => x.id === entryId);
      if (entry) return { list, entry };
    }
  }
  return null;
}

function selected() {
  const list = activePlan()?.lists[state.selection.listIndex];
  const entry = list && state.selection.entryIndex >= 0 ? list.entries[state.selection.entryIndex] : null;
  return entry ? { list, entry } : null;
}


// `size` is the entry's recorded [width, height]. With it, the element's box is
// sized up front (see .entry img.sized), so the picture can arrive whenever it
// likes without shifting the board — which is also why reveal() only waits on
// unsized images.
function imgFor(id, size) {
  let el = imgCache.get(id);
  if (!el) {
    el = document.createElement("img");
    el.alt = "";
    el.decoding = "async";
    el.draggable = false; // a native image drag would hijack Sortable's entry drag
    el.src = imgSrc(id);
    el.addEventListener("error", () => healBrokenImage(id));
    el.addEventListener("load", () => recordImageSize(id, el));
    imgCache.set(id, el);
  }
  if (size && !el.classList.contains("sized")) {
    el.style.setProperty("--w", size[0]);
    el.style.setProperty("--h", size[1]);
    el.classList.add("sized");
  }
  return el;
}

// Backfill for images stored before sizes were recorded: one save, after which
// every later load reserves the box up front.
function recordImageSize(id, el) {
  if (!el.naturalWidth || !el.naturalHeight) return;
  let changed = false;
  eachEntry(state.data, (e) => {
    if (e.image === id && !e.imageSize) { e.imageSize = [el.naturalWidth, el.naturalHeight]; changed = true; }
  });
  if (changed) save();
}

async function imageSize(blob) {
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const size = [bmp.width, bmp.height];
    bmp.close();
    return size;
  } catch { return null; }
}

// A reference whose bytes are gone renders as a broken image forever, so drop
// it — but only on a confirmed 404. The same error event fires for a dropped
// connection, and discarding a live image over one lost packet is not
// recoverable.
async function healBrokenImage(id) {
  // Uploaded in this session: it exists, whatever a read says, and acting on a
  // bad read would destroy an image the user just pasted.
  if (objectUrls.has(id)) return;
  if (healing.has(id)) return;
  healing.add(id);
  try {
    const res = await fetch(imgUrl(id), { method: "HEAD", cache: "no-store" });
    if (res.status !== 404) { healing.delete(id); return; }
  } catch { healing.delete(id); return; }
  imgCache.delete(id);
  let changed = false;
  eachEntry(state.data, (e) => { if (e.image === id) { delete e.image; delete e.imageSize; changed = true; } });
  if (changed) { save(); render(); }
}

// Downscale and re-encode before upload: a pasted screenshot is routinely 4MB
// of PNG that renders into a ~300px column. Returns null when nothing usable
// came out, so the caller can bail instead of uploading something the server
// will reject.
async function encodeImage(file) {
  // A canvas round-trip flattens an animated GIF to its first frame.
  if (file.type === "image/gif") return file.size <= MAX_IMAGE_BYTES ? file : null;
  let out = null;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, IMG_MAX_DIM / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    // Browsers without WebP encoding fall back to PNG here, which is also fine.
    out = await new Promise((r) => canvas.toBlob(r, "image/webp", 0.85));
  } catch { out = null; }
  const original = ALLOWED_TYPES.has(file.type) && file.size <= MAX_IMAGE_BYTES ? file : null;
  if (!out || !ALLOWED_TYPES.has(out.type) || out.size > MAX_IMAGE_BYTES) return original;
  // Re-encoding a small image can make it bigger; keep whichever is smaller.
  return original && original.size <= out.size ? original : out;
}

async function attachImage(file, listId, entryId) {
  const blob = await encodeImage(file);
  if (!blob) return;
  const size = await imageSize(blob);
  uploads++;
  let id = null;
  try {
    const res = await fetch("/api/img", {
      method: "POST",
      headers: { "Content-Type": blob.type },
      body: blob
    });
    if (res.ok) id = (await res.json()).id;
  } catch { /* offline — nothing was stored */ }
  finally { uploads--; }
  if (!id) return;

  const found = findEntry(listId, entryId);
  // The entry can be deleted while the bytes are still going up, in which case
  // nothing will ever reference this object. Drop it now rather than leaving it
  // for the server's sweep. The endpoint refuses any id the live blob
  // references, so this can never destroy an image that is actually in use.
  if (!found) { fetch(imgUrl(id), { method: "DELETE" }).catch(() => {}); return; }

  objectUrls.set(id, URL.createObjectURL(blob)); // render from the bytes we already hold
  pushHistory();
  found.entry.image = id;
  if (size) found.entry.imageSize = size; else delete found.entry.imageSize;
  saveNow(); // get the reference to the server promptly — until it lands, the object is an orphan
  if (body.dataset.mode === "insert") {
    // Mid-edit: render() would tear out the live textarea, so patch the node.
    const li = entryEls.get(entryId);
    if (li) { li.querySelector("img")?.remove(); li.appendChild(imgFor(id, size)); }
  } else render();
}

// Dropping the reference is the whole operation — the server deletes the object
// when it sees the new blob. Deliberately not undoable: the bytes are gone, so a
// restored reference could only render as a broken image, which is why
// scrubHistory strips the id from every snapshot on the save below.
function detachImage(listId, entryId) {
  const found = findEntry(listId, entryId);
  if (!found?.entry.image) return;
  delete found.entry.image;
  delete found.entry.imageSize;
  // An entry that was only ever an image has nothing left to show. render()
  // re-clamps the selection afterwards.
  if (!found.entry.text) found.list.entries.splice(found.list.entries.indexOf(found.entry), 1);
  saveNow();
  render();
}

// Where a pasted image lands: the entry being edited, or the selected one.
// Editing a list name has no entry, so an image paste there is ignored.
function pasteTarget() {
  if (body.dataset.mode === "insert") {
    const li = document.activeElement?.closest?.(".entry");
    const sec = li?.closest(".list");
    return li && sec ? { listId: sec.dataset.listId, entryId: li.dataset.entryId } : null;
  }
  const sel = selected();
  return sel && { listId: sel.list.id, entryId: sel.entry.id };
}

// Ctrl+V with an image on the clipboard. Works the same on mobile, where the
// long-press paste menu delivers the same event into the open textarea.
document.addEventListener("paste", (e) => {
  const mode = body.dataset.mode;
  if (mode !== "normal" && mode !== "insert") return;
  const file = [...(e.clipboardData?.items || [])]
    .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
    .map((i) => i.getAsFile())
    .find(Boolean);
  if (!file) return; // ordinary text paste — leave it to the browser
  const target = pasteTarget();
  if (!target) return;
  e.preventDefault();
  attachImage(file, target.listId, target.entryId);
});

// ---------- image preview ----------
let imgView = null; // { id, listId, entryId } while the preview is open

function openImageView(listId, entryId) {
  const found = findEntry(listId, entryId);
  if (!found?.entry.image) return;
  imgView = { id: found.entry.image, listId, entryId };
  $("img-view-img").src = imgSrc(found.entry.image);
  setMode("image");
  $("img-view").showModal();
}

// Clicking/tapping an entry's image opens it, and selects the entry so the
// preview's delete acts on something the board also shows as selected.
function openImageViewFromNode(imgEl) {
  const li = imgEl.closest(".entry");
  const listId = li.closest(".list").dataset.listId, entryId = li.dataset.entryId;
  if (selectById(listId, entryId)) openImageView(listId, entryId);
}

(function setupImageView() {
  const dlg = $("img-view");
  // imgSrc, not imgUrl: an image pasted this session opens from the in-memory
  // copy, with no round-trip.
  const openTab = () => { if (imgView) window.open(imgSrc(imgView.id), "_blank", "noopener"); };
  const remove = () => {
    if (!imgView) return;
    const { listId, entryId } = imgView;
    dlg.close();
    detachImage(listId, entryId);
  };
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(); }
    else if (e.key === "n" || e.key === "N") { e.preventDefault(); openTab(); }
    // Escape: see the dialog handler near the end of the file.
  });
  dlg.addEventListener("close", () => {
    imgView = null;
    // Release the decoded copy the dialog was holding; the board keeps its own.
    $("img-view-img").removeAttribute("src");
    setMode("normal");
  });
  fastTap($("img-open"), openTab);
  fastTap($("img-del"), remove);
})();

// Clicking anywhere while not editing ends the Enter-chain burst.
document.addEventListener("pointerdown", () => {
  if (body.dataset.mode === "normal") state.chainArmed = false;
});

// ---------- click/tap outside a list deselects ----------
// Clear the selection when the empty board area is activated. In single view the
// active list must stay visible — nulling listIndex would leave no list with
// [data-active], and the CSS hides every list but the active one, blanking the
// whole board. So single view only drops the entry selection; multi view fully
// deselects.
function deselectOutside() {
  if (body.dataset.view === "single") {
    if (state.selection.entryIndex === -1) return;
    state.selection.entryIndex = -1;
  } else {
    if (state.selection.listIndex === -1 && state.selection.entryIndex === -1) return;
    state.selection.listIndex = -1;
    state.selection.entryIndex = -1;
  }
  render();
}

// ---------- click/tap to edit ----------
// Opening an editor stays on `click`: the native click is what makes mobile
// browsers draw the caret and raise the keyboard for a programmatic focus().
// Firing our own focus() on pointerup instead left the caret invisible. A
// scroll/drag fires no click, so this only triggers on a genuine tap.
board.addEventListener("click", (e) => {
  if (body.dataset.mode !== "normal") return; // already editing — let the field handle the tap
  const t = e.target;
  if (t.matches(".entry img")) { openImageViewFromNode(t); return; }
  const sec = t.closest(".list");
  // Desktop deselects on click: a drag-to-scroll fires no click, so the
  // selection survives scrolling. Touch deselects on pointerdown (setupTouch).
  if (!sec) { if (!state.isTouch) deselectOutside(); return; }
  const entry = t.closest(".entry");
  if (entry) editEntryById(sec.dataset.listId, entry.dataset.entryId, e.clientX, e.clientY);
  else if (state.isTouch && t.closest(".list-name")) editListById(sec.dataset.listId);
});

// ---------- mouse drag-to-scroll (desktop) ----------
(function setupDragScroll() {
  let drag = null;
  board.addEventListener("pointerdown", (e) => {
    if (state.isTouch || e.button !== 0) return;
    if (e.target.closest(".entry") || e.target.closest(".list-name")) return;
    const scroller = e.target.closest(".entries") || board;
    drag = { sx: scroller.scrollLeft, sy: scroller.scrollTop, x: e.clientX, y: e.clientY, scroller, pid: e.pointerId, moved: false };
  });
  board.addEventListener("pointermove", (e) => {
    if (!drag || drag.pid !== e.pointerId) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) { drag.moved = true; board.setPointerCapture(e.pointerId); body.classList.add("dragging-scroll"); }
    drag.scroller.scrollLeft = drag.sx - dx;
    drag.scroller.scrollTop = drag.sy - dy;
  });
  const end = (e) => {
    if (drag?.moved) {
      board.releasePointerCapture(drag.pid);
      // Single-list view: a horizontal drag on empty board area cycles lists.
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (body.dataset.view === "single" && drag.scroller === board && Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy)) {
        move(dx < 0 ? 1 : -1, 0);
      }
    }
    drag = null;
    body.classList.remove("dragging-scroll");
  };
  board.addEventListener("pointerup", end);
  board.addEventListener("pointercancel", end);
})();

// ---------- keyboard ----------
const ARROWS = {
  ArrowUp: [0, -1], k: [0, -1], ArrowDown: [0, 1], j: [0, 1],
  ArrowLeft: [-1, 0], h: [-1, 0], ArrowRight: [1, 0], l: [1, 0],
};
document.addEventListener("keydown", (e) => {
  if (body.dataset.mode !== "normal" || isField(e.target)) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.ctrlKey && !e.altKey) {
    const sel = selected();
    if (key === "c" && sel) { e.preventDefault(); navigator.clipboard?.writeText(sel.entry.text); }
    else if (key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    // Ctrl+Shift+V — remove the selected entry's image. Normal mode only, so it
    // doesn't shadow paste-as-plain-text while editing.
    else if (key === "v" && e.shiftKey) { e.preventDefault(); if (sel) detachImage(sel.list.id, sel.entry.id); }
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return; // let browser shortcuts (Ctrl+R, etc.) through
  if (e.key !== "Enter") state.chainArmed = false; // anything but a straight Enter run ends the burst

  const dir = ARROWS[key];
  if (dir) { e.preventDefault(); (e.shiftKey ? shiftMove : move)(...dir); return; }
  switch (e.key) {
    case "Enter":      e.preventDefault(); newEntryBelow(); break;
    case "Delete":
    case "Backspace":
      e.preventDefault();
      if (state.selection.entryIndex >= 0) deleteEntry();
      else deleteCurrentList();
      break;
    case "Escape":
      e.preventDefault();
      state.selection.entryIndex = -1;
      render(); scrollSelectionIntoView();
      break;
    case "n": e.preventDefault(); newList(); break;
    case "b": e.preventDefault(); openBg(); break;
    case "Tab": e.preventDefault(); toggleTodo(); break;
    case "e":
      e.preventDefault();
      if (state.selection.entryIndex >= 0) editEntry(state.selection.listIndex, state.selection.entryIndex);
      else editList(state.selection.listIndex);
      break;
    case "r": e.preventDefault(); deleteCurrentPlan(); break;
    case "o": {
      e.preventDefault();
      const sel = selected();
      if (sel) openImageView(sel.list.id, sel.entry.id);
      break;
    }
    case " ": e.preventDefault(); openPalette(); break;
    case "v": if (!state.isTouch) { e.preventDefault(); toggleView(); } break;
  }
});

// Open an entry / list header for editing by id, resolving indices against the
// *current* data — safe to call right after a commit re-rendered the board (the
// tapped DOM node is stale by then, but its id still points at live data).
// Select a list (no entryId) or entry by id and re-render. False if it's gone.
function selectById(listId, entryId) {
  const lists = activePlan().lists;
  const li = lists.findIndex((l) => l.id === listId);
  const ei = entryId ? lists[li]?.entries.findIndex((en) => en.id === entryId) ?? -1 : -1;
  if (li < 0 || (entryId && ei < 0)) return false;
  state.selection = { listIndex: li, entryIndex: ei };
  render();
  return true;
}
function editEntryById(listId, entryId, x, y) {
  if (!selectById(listId, entryId)) return;
  const { listIndex: li, entryIndex: ei } = state.selection;
  const fresh = entryEls.get(entryId);
  if (fresh) editEntry(li, ei, false, caretOffsetFromPoint(x, y, fresh));
}
function editListById(listId) {
  if (selectById(listId)) editList(state.selection.listIndex);
}

// ---------- touch ----------
function setupTouch() {
  if (!state.isTouch) return;
  body.classList.add("touch");

  // Touching the board while editing always commits the open field. What happens
  // next depends on where the touch landed and whether it travelled:
  //   • inside the active field            → left alone (place caret / select text)
  //   • tap on an entry/header in SAME list → commit, open the tapped one at the
  //                                           tapped spot (re-resolved by id, the
  //                                           commit having re-rendered the board)
  //   • tap anywhere else (other list/empty) → commit + deselect
  //   • the touch scrolled                  → commit + deselect, nothing opened
  //
  // Which of those it is can't be known when the finger lands — a touch on an
  // entry is equally the start of a scroll — so pointerdown only *arms* the
  // decision and touchend makes it, by how far the finger travelled. Committing
  // on pointerdown (as this used to) re-renders the board out from under the
  // gesture: the <ul> being scrolled is detached mid-scroll, so the list freezes
  // and the entry under the finger opens instead.
  let dismiss = null;
  // `target` is the same-list entry/header to open after the commit, or null to
  // deselect instead. x/y are the tap point, for caret placement.
  const dismissEdit = (swallow, target, x, y) => {
    // The commit re-renders, so a trailing click would land on a detached node.
    if (swallow) swallowNextClick();
    const active = document.activeElement;
    if (isField(active)) active.blur(); // commit + hide keyboard
    else { setMode("normal"); render(); } // stuck in insert with no live field — recover
    if (!target) { deselectOutside(); return; }
    if (target.entryId) editEntryById(target.listId, target.entryId, x, y);
    else editListById(target.listId);
  };
  const endDismiss = (e) => {
    const start = dismiss;
    dismiss = null;
    if (!start || body.dataset.mode !== "insert") return;
    const t = e.changedTouches?.[0];
    // A tap fires a trailing click and needs it swallowed; a scroll fires none,
    // and swallowing there would eat the next real tap instead.
    const moved = !t || Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10;
    dismissEdit(!moved, moved ? null : start.target, start.x, start.y);
  };
  // Bubble phase, so the swipe handler on `board` runs first and still sees
  // `insert` — a scroll that drifted sideways must not also switch lists.
  document.addEventListener("touchend", endDismiss);
  document.addEventListener("touchcancel", endDismiss);

  // Resolve the tapped entry/header now, while the node is still live: only a
  // target in the list being edited re-opens (another list behaves like a
  // background tap).
  const editTargetFrom = (e, active) => {
    const editingSec = active?.closest(".list");
    const targetSec = e.target.closest(".list");
    if (!editingSec || targetSec !== editingSec) return null;
    const entry = e.target.closest(".entry");
    if (!entry && !e.target.closest(".list-name")) return null;
    return { listId: targetSec.dataset.listId, entryId: entry?.dataset.entryId };
  };

  board.addEventListener("pointerdown", (e) => {
    if (body.dataset.mode === "insert") {
      const active = document.activeElement;
      const editing = isField(active);
      if (editing && active.contains(e.target)) return;
      const target = editing ? editTargetFrom(e, active) : null;
      // A mouse on a touch-capable device fires no touchend — decide on press.
      if (e.pointerType !== "touch") { dismissEdit(true, target, e.clientX, e.clientY); return; }
      if (!dismiss) dismiss = { x: e.clientX, y: e.clientY, target }; // extra fingers ride the first one
      return;
    }
    // A real target handles its own tap.
    if (!e.target.closest(".list") && body.dataset.mode === "normal") deselectOutside();
  }, true);

  let touchStart = null;
  board.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { passive: true });
  board.addEventListener("touchend", (e) => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x, dy = t.clientY - touchStart.y;
    touchStart = null;
    // Single-list view: swipe cycles lists. Not while editing: selecting text
    // drags the finger across the field, which isn't a list-switch swipe.
    if (body.dataset.view !== "single" || body.dataset.mode === "insert") return;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) move(dx < 0 ? 1 : -1, 0);
  });

  // Chrome buttons fire on press, not on the synthetic click on release.
  fastTap($("nav-toggle"), () => body.classList.toggle("nav-open"));
  fastTap($("actions"), (e) => ({
    "del-plan": deleteCurrentPlan,
    "new-list": newList,
    "del-list": deleteCurrentList,
    "toggle-todo": toggleTodo
  })[e.target.dataset.act]?.());
  fastTap($("m-palette"), openPalette);
  fastTap($("m-view"), toggleView);
}

// Backdrop click closes a dialog (mobile expectation).
["palette", "confirm", "bg"].forEach((id) => attachBackdropClose($(id)));

// Escape closes the open dialog. Native for modals elsewhere, but Servo has no
// cancel action; running first (capture) and preventing it keeps it one close.
window.addEventListener("keydown", (e) => {
  const dlg = e.key === "Escape" && document.querySelector("dialog[open]");
  if (dlg) { e.preventDefault(); dlg.close(); }
}, true);

// The preview fills the viewport, so its "backdrop" is everything that isn't
// the picture or the action bar — attachBackdropClose's `target === dialog`
// test would miss the letterboxing around a contained image.
$("img-view").addEventListener("pointerdown", (e) => {
  if (e.target === $("img-view-img") || e.target.closest("#img-actions")) return;
  if (state.isTouch) swallowNextClick();
  $("img-view").close();
});

// Modal Confirm buttons submit on pointerdown so they react on press, not on the
// delayed click. preventDefault stops the trailing click from submitting twice.
if (state.isTouch) {
  document.querySelectorAll(".confirm-btn").forEach((btn) => {
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      swallowNextClick(); // closing on press lets the trailing click fall through to the board
      btn.form?.requestSubmit(btn);
    });
  });
}

// ---------- boot ----------
// The page arrives hidden (body:not(.ready) in styles.css) and is revealed only
// once the first render is complete — fonts in, any image without a reserved box decoded
// — so the first painted frame is the settled one. Capped, so a slow font or
// image costs a late shift rather than a blank screen.
async function reveal() {
  if (body.classList.contains("ready")) return;
  await Promise.race([
    // Async wrapper: a browser without FontFaceSet.load (older Servo) rejects
    // into the catch instead of throwing past it and never revealing the page.
    (async () => Promise.all([
      document.fonts.load("1em Sora"),
      document.fonts.load("1em 'Hammersmith One'"),
      ...[...board.querySelectorAll("img:not(.sized)")].map((img) => img.decode()),
    ]))().catch(() => {}),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
  body.classList.add("ready");
}

async function loadData() {
  // Inlined by the server on the initial page load; only fetched if that read
  // failed (or the previous fetch did, retried every few seconds).
  const boot = $("boot");
  let data = boot ? JSON.parse(boot.textContent) : undefined;
  boot?.remove();
  if (data === undefined) {
    const res = await fetch("/api/data").catch(() => null);
    data = res?.ok ? await res.json() : null;
  }
  if (!data) { await reveal(); setTimeout(loadData, 3000); return; }
  state.data = data;
  if (state.isTouch || innerWidth < 600) body.dataset.view = "single";
  setupTouch();
  render();
  await reveal();
  board.focus();
  preloadBackgrounds();
}

// ---------- cross-device sync ----------
// Swap in a fresh server snapshot and repaint. Selection lives outside the data
// blob (in state.selection), so render() re-clamps it.
function applyRemote(remote) {
  state.data = remote;
  history.length = 0; // snapshots are relative to the old blob; don't let undo clobber remote edits
  render();
}

// Re-fetch on focus/visibility so another device's edits show up. Skipped while
// editing or with an unsaved change, to avoid stomping in-progress work.
// Returning to the tab fires both focus and visibilitychange; `refreshing`
// folds them into one fetch.
let refreshing = false;
async function refresh() {
  if (refreshing || !state.data.plans.length) return; // in flight / not booted yet
  if (savePending || uploads > 0 || body.dataset.mode === "insert") return;
  let res;
  refreshing = true;
  // The server answers 304 (not ok, so nothing to do) while our version is current.
  try { res = await fetch("/api/data", { cache: "no-store", headers: { "X-Plan-Version": String(state.data.version ?? 0) } }); }
  catch { return; }
  finally { refreshing = false; }
  if (!res.ok) return;
  const remote = await res.json();
  // Strictly newer only. A refresh racing a save can hand back the blob we just
  // replaced — adopting that would roll our own edits back, and an image
  // reference lost that way gets its bytes deleted by the next write's diff.
  if (remote.version > (state.data.version ?? 0)) applyRemote(remote);
}

window.addEventListener("focus", refresh);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh();
});

// An in-flight upload is guarded too: leaving before its reference is saved
// would leave the image unreferenced until the server's next sweep.
window.addEventListener("beforeunload", (e) => {
  if (savePending || uploads > 0) { e.preventDefault(); e.returnValue = ""; }
});

if (!window.Sortable) $("sortable-js").addEventListener("load", attachSortables);

// The server inlines the data blob into the page, so boot needs no round-trip
// at all.
loadData();
