const $ = (id) => document.getElementById(id);
const body = document.body;
const board = $("board");

const state = {
  data: { activePlanId: "", plans: [] },
  selection: { listIndex: 0, entryIndex: -1 },
  isTouch: matchMedia("(hover: none) and (pointer: coarse)").matches
    || /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent),
  // Mobile: the first entry made after arriving at a list saves-and-stops
  // (keyboard hides); every entry made after that chains. Reset when the
  // viewed list changes (see render()).
  firstEntryMade: false,
  // Desktop: Enter on a freshly added entry saves-and-stops until the chain is
  // armed, which that same commit does — so the next Enter, and every one after
  // it, also opens the following entry. Disarmed by anything else (see keydown).
  chainArmed: false,
  viewedListId: null,
  // The most recent list index that was actually selected (>= 0). Used to fall
  // back to a sensible list when nothing is selected (delete-list / toggle-view).
  lastListIndex: 0
};

const uuid = () => crypto.randomUUID();
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
  // Strip blank entries on a clone, so an in-progress edit survives in memory.
  // An entry carrying an image is never blank — the picture is its content, and
  // dropping it here would hide the reference from the server, whose orphan
  // diff would then delete an image the client is still showing.
  const cleaned = JSON.parse(JSON.stringify(state.data));
  cleaned.plans.forEach((p) => p.lists.forEach((l) => {
    l.entries = l.entries.filter((e) => (e.text && e.text.trim()) || e.image);
  }));
  const res = await fetch("/api/data", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Plan-Version": String(state.data.version ?? 0)
    },
    body: JSON.stringify(cleaned)
  });
  if (res.status === 409) {
    // Another device wrote first; adopt its state instead of clobbering.
    applyRemote(await res.json());
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
    data: JSON.parse(JSON.stringify(state.data)),
    selection: { ...state.selection }
  });
  if (history.length > HISTORY_LIMIT) history.shift();
}
// Drop the most recent snapshot — used when an action is abandoned (e.g. a new
// entry/list created then cancelled), so undo doesn't replay a no-op.
function popHistory() { history.pop(); }
// The server deletes an image the moment the blob stops referencing it, so a
// snapshot must never hold a reference the live data has dropped — undoing into
// one would restore a permanently broken image. Runs on every save, which is
// the only thing that can make an id unreferenced. The element cache is pruned
// on the same pass for the same reason.
function scrubHistory() {
  const live = liveImageIds();
  for (const snap of history) {
    eachEntry(snap.data, (e) => { if (e.image && !live.has(e.image)) delete e.image; });
  }
  for (const id of imgCache.keys()) if (!live.has(id)) imgCache.delete(id);
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
function render() {
  const plan = activePlan();
  if (!plan) { board.innerHTML = ""; return; }

  if (state.selection.listIndex >= plan.lists.length) state.selection.listIndex = Math.max(0, plan.lists.length - 1);
  const list = plan.lists[state.selection.listIndex];
  if (list && state.selection.entryIndex >= list.entries.length) state.selection.entryIndex = list.entries.length - 1;

  // Remember the last genuinely-selected list so we can fall back to it when the
  // selection is cleared (delete-list with nothing active, toggle-view, etc.).
  if (state.selection.listIndex >= 0) state.lastListIndex = state.selection.listIndex;

  // Whenever the viewed list changes, the next entry made is again a "first"
  // one that saves-and-stops on mobile (see editEntry).
  const viewedId = list?.id ?? null;
  if (viewedId !== state.viewedListId) { state.viewedListId = viewedId; state.firstEntryMade = false; }

  // Preserve per-list scroll positions across the rebuild.
  const scrolls = {};
  board.querySelectorAll(".entries").forEach((ul) => { scrolls[ul.dataset.listId] = ul.scrollTop; });
  const boardScrollLeft = board.scrollLeft;
  board.innerHTML = "";
  plan.lists.forEach((l, li) => {
    const el = document.createElement("section");
    el.className = "list";
    el.dataset.listId = l.id;
    if (li === state.selection.listIndex) {
      el.dataset.selected = ""; el.dataset.active = "";
      if (state.selection.entryIndex === -1) el.dataset.listSelected = "";
      else if (state.selection.entryIndex === 0) el.dataset.firstSelected = "";
    }

    const name = document.createElement("div");
    name.className = "list-name";
    name.textContent = l.name;
    name.dataset.role = "list-name";
    el.appendChild(name);

    const ul = document.createElement("ul");
    ul.className = "entries";
    ul.dataset.listId = l.id;
    l.entries.forEach((e, ei) => {
      const it = document.createElement("li");
      it.className = "entry";
      it.dataset.entryId = e.id;
      it.textContent = e.text;
      // Appended after the text, so `it.firstChild` stays the text node that
      // caretOffsetFromPoint measures against.
      if (e.image) it.appendChild(imgFor(e.image));
      if (/^-{2,}(\s.*\s-{2,})?$/.test(e.text)) it.dataset.sep = "";
      if (e.todo) it.dataset.todo = "";
      if (li === state.selection.listIndex && ei === state.selection.entryIndex) it.dataset.selected = "";
      ul.appendChild(it);
    });
    el.appendChild(ul);
    board.appendChild(el);
    if (scrolls[l.id] != null) ul.scrollTop = scrolls[l.id];
  });
  board.scrollLeft = boardScrollLeft;

  renderDots(plan);
  attachSortables();
  $("m-plan-name").textContent = plan.name || "—";
  $("m-del-plan").hidden = plan.name === "Plan";
  document.title = !plan.name ? "plan" : plan.name === "Plan" ? "Plan" : `${plan.name} plan`;
  const bg = plan.background;
  if (bg) {
    body.style.backgroundImage = `url("${bg.replace(/"/g, "%22")}")`;
    body.style.backgroundSize = "cover";
    body.style.backgroundPosition = "center";
  } else {
    body.style.backgroundImage = "";
  }
}

function renderDots(plan) {
  const dots = $("dots");
  dots.innerHTML = "";
  if (plan.lists.length <= 1) { dots.hidden = true; return; }
  dots.hidden = false;
  plan.lists.forEach((_, i) => {
    const d = document.createElement("span");
    if (i === state.selection.listIndex) d.dataset.active = "";
    dots.appendChild(d);
  });
}

// ---------- sortable ----------
let sortables = [];
function destroySortables() { sortables.forEach((s) => s.destroy()); sortables = []; }
// Toggle dragging on all sortables. Disabled while editing so a mouse-drag to
// select text inside the field isn't hijacked into an entry/list drag (which
// also left the board in a glitched, unselectable state on abort). Ending an
// edit calls render(), which rebuilds fresh (enabled) sortables.
function setDragEnabled(on) { sortables.forEach((s) => s.option("disabled", !on)); }

// Auto-scroll a list while dragging an entry near its top/bottom edge. Works for
// both desktop (native drag -> dragover) and touch (Sortable fallback -> touchmove).
const autoScroll = { active: false, raf: 0, x: 0, y: 0 };
function autoScrollTrack(e) {
  const t = e.touches?.[0] || e.changedTouches?.[0] || e;
  if (t.clientX != null) { autoScroll.x = t.clientX; autoScroll.y = t.clientY; }
}
function autoScrollStep() {
  if (!autoScroll.active) return;
  const { x, y } = autoScroll;
  // Horizontal board scroll near its left/right edges. Reveals the neighbouring
  // lists while dragging a list, or an entry across lists.
  {
    const r = board.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      const zone = Math.max(40, r.width * 0.08); // left/right 8% (min 40px)
      const maxSpeed = 20; // px per frame at the very edge
      let dx = 0;
      if (x < r.left + zone) dx = -maxSpeed * ((r.left + zone - x) / zone);
      else if (x > r.right - zone) dx = maxSpeed * ((x - (r.right - zone)) / zone);
      if (dx) board.scrollLeft += dx;
    }
  }
  // Vertical scroll within whichever list the pointer is hovering.
  board.querySelectorAll(".entries").forEach((ul) => {
    const r = ul.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return;
    const zone = Math.max(24, r.height * 0.1); // top/bottom 10% (min 24px for short lists)
    const maxSpeed = 14; // px per frame at the very edge
    let delta = 0;
    if (y < r.top + zone) delta = -maxSpeed * ((r.top + zone - y) / zone);
    else if (y > r.bottom - zone) delta = maxSpeed * ((y - (r.bottom - zone)) / zone);
    if (delta) ul.scrollTop += delta;
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
  destroySortables();
  const plan = activePlan();
  if (!plan) return;

  // Set when a drag begins in single view: siblings are revealed for the
  // duration of the drag, then hidden again on drop. Shared by both the list
  // sortable and the entry sortables so either kind of drag can reach the
  // neighbouring lists. Single view shows only the active list, so a dragged
  // list/entry would otherwise have nowhere to go.
  let autoMulti = false;
  function revealSiblingsForDrag() {
    if (body.dataset.view !== "single") return;
    autoMulti = true;
    body.dataset.view = "multi";
    const sec = board.querySelectorAll(".list")[state.selection.listIndex];
    if (!sec) return;
    // The active list is centered in single view. Revealing the siblings would
    // otherwise let the first/last list slide to the board edge (nothing on one
    // side to scroll against). Pad the board ends by exactly the empty space
    // that flanks a centered list, so every list — including the first and last
    // — can scroll to the same center position and the grabbed one stays put.
    const pad = Math.max(0, (board.clientWidth - sec.offsetWidth) / 2);
    board.style.paddingLeft = board.style.paddingRight = pad + "px";
    sec.scrollIntoView({ behavior: "instant", inline: "center", block: "nearest" });
  }
  function clearDragPadding() {
    board.style.paddingLeft = board.style.paddingRight = "";
  }
  sortables.push(Sortable.create(board, {
    group: "lists",
    animation: 120,
    draggable: ".list",
    filter: ".entries, .list-name input, .entry input",
    preventOnFilter: false,
    onStart: () => {
      body.classList.add("dragging");
      startAutoScroll();
      revealSiblingsForDrag();
    },
    onEnd: (ev) => {
      body.classList.remove("dragging");
      stopAutoScroll();
      clearDragPadding();
      const reverted = autoMulti;
      autoMulti = false;
      if (ev.oldIndex !== ev.newIndex) {
        pushHistory();
        const moved = plan.lists.splice(ev.oldIndex, 1)[0];
        plan.lists.splice(ev.newIndex, 0, moved);
        state.selection.listIndex = ev.newIndex;
        save();
      }
      if (reverted) body.dataset.view = "single";
      // Re-attach sortables (via render) whenever the order changed or the view
      // was flipped back, so the entry sortables get the right pull/put again.
      if (reverted || ev.oldIndex !== ev.newIndex) render();
    }
  }));

  board.querySelectorAll(".entries").forEach((ul) => {
    sortables.push(Sortable.create(ul, {
      // Cross-list moves stay enabled even in single view: the drag reveals the
      // neighbouring lists (see revealSiblingsForDrag) so an entry can be dropped
      // into any of them.
      group: { name: "entries", pull: true, put: true },
      animation: 120,
      draggable: ".entry",
      scroll: false, // handled by our own edge auto-scroll (startAutoScroll)
      // Touch: brief hold before drag, so a quick swipe scrolls instead.
      delay: 250,
      delayOnTouchOnly: true,
      touchStartThreshold: 5,
      onStart: () => {
        body.classList.add("dragging");
        startAutoScroll();
        revealSiblingsForDrag();
      },
      onEnd: (ev) => {
        body.classList.remove("dragging");
        stopAutoScroll();
        clearDragPadding();
        const reverted = autoMulti;
        autoMulti = false;
        const fromList = plan.lists.find((l) => l.id === ev.from.dataset.listId);
        const toList = plan.lists.find((l) => l.id === ev.to.dataset.listId);
        const moved = fromList && toList && !(fromList === toList && ev.oldIndex === ev.newIndex);
        if (moved) {
          pushHistory();
          const [entry] = fromList.entries.splice(ev.oldIndex, 1);
          toList.entries.splice(ev.newIndex, 0, entry);
          state.selection.listIndex = plan.lists.indexOf(toList);
          state.selection.entryIndex = ev.newIndex;
          save();
        }
        if (reverted) body.dataset.view = "single";
        if (moved || reverted) render();
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
  let best = null, bestDist = Infinity;
  for (let i = 0; i < len; i++) {
    range.setStart(text, i);
    range.setEnd(text, i + 1);
    for (const r of range.getClientRects()) {
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
      if (document.body.dataset.mode === "insert") input.focus();
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
  const sec = board.querySelectorAll(".list")[listIndex];
  const nameEl = sec.querySelector(".list-name");
  nameEl.textContent = "";
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
      if (state.selection.listIndex >= plan.lists.length) state.selection.listIndex = Math.max(0, plan.lists.length - 1);
      state.selection.entryIndex = -1;
      popHistory(); // discard the snapshot newList() pushed for this abandoned list
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
  if (!list) return;
  const entry = list.entries[entryIndex];
  if (!entry) return;
  setMode("insert");
  setDragEnabled(false);
  const sec = board.querySelectorAll(".list")[listIndex];
  const it = sec.querySelectorAll(".entry")[entryIndex];
  // Only the text is replaced by the field — an attached image stays visible
  // while its entry is being edited.
  const img = it.querySelector("img");
  it.textContent = "";
  const input = document.createElement("textarea");
  input.value = entry.text;
  input.rows = 1;
  it.appendChild(input);
  if (img) it.appendChild(img);
  const resize = () => { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; };
  input.addEventListener("input", resize);
  resize();
  input.focus();
  const caret = caretPos != null && caretPos >= 0 && caretPos <= input.value.length
    ? caretPos : input.value.length;
  const applyCaret = () => input.setSelectionRange(caret, caret);
  applyCaret();
  // iOS WebKit parks the caret at the focus position (end of text) and won't
  // repaint it for a programmatic mid-text selection until the next interaction —
  // so the caret stayed invisible until you typed. Re-applying the selection on
  // the next frame forces WebKit to draw it at the tapped spot right away.
  requestAnimationFrame(applyCaret);
  const stopKeep = keepFocusOnTabSwitch(input);
  let cancelled = false;
  let chain = false;
  let armsChain = false;
  const commit = () => {
    stopKeep();
    const v = input.value.trim();
    if (isNew) { if (!v && !entry.image) popHistory(); } // abandoned new entry — discard its snapshot
    else if (v !== entry.text) pushHistory();
    if (v) entry.text = v;
    // An entry that carries an image survives an empty field — the picture is
    // the content. Splicing it would destroy the image along with it.
    else if (entry.image) entry.text = "";
    else list.entries.splice(entryIndex, 1);
    // Mobile: once a new entry has been saved in this list, later entries chain.
    if (isNew && v) state.firstEntryMade = true;
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
      // that chains. Mobile: a new entry chains only after the first one has been
      // made (the first saves-and-stops); editing an existing entry chains only
      // when left unmodified — Enter after an edit just commits, but Enter on an
      // untouched entry adds a new one.
      const modified = input.value.trim() !== entry.text;
      // The new-list flow (chainable) always keeps going on Enter; only tapping
      // outside — a blur with no Enter — ends it. Otherwise fall back to the
      // per-platform rule.
      chain = chainable ? true : (state.isTouch ? (isNew ? state.firstEntryMade : !modified) : (isNew && state.chainArmed));
      armsChain = !chainable && !state.isTouch && isNew && !state.chainArmed;
      input.blur();
    }
    else if (e.key === "Escape") {
      e.preventDefault(); cancelled = true; stopKeep(); state.chainArmed = false;
      if (!entry.text && !entry.image) { list.entries.splice(entryIndex, 1); if (isNew) popHistory(); save(); }
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
  const at = state.selection.entryIndex >= 0 ? state.selection.entryIndex + 1 : list.entries.length;
  const entry = { id: uuid(), text: "" };
  list.entries.splice(at, 0, entry);
  state.selection.entryIndex = at;
  save();
  render();
  editEntry(state.selection.listIndex, at, true, null, chainable);
}

function toggleTodo() {
  const plan = activePlan();
  const list = plan.lists[state.selection.listIndex];
  if (!list || state.selection.entryIndex < 0) return;
  const entry = list.entries[state.selection.entryIndex];
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
  const plan = activePlan();
  const list = plan.lists[state.selection.listIndex];
  if (!list || state.selection.entryIndex < 0) return;
  pushHistory();
  list.entries.splice(state.selection.entryIndex, 1);
  if (state.selection.entryIndex >= list.entries.length) state.selection.entryIndex = list.entries.length - 1;
  saveNow(); render();
}

function deleteCurrentPlan() {
  const plan = activePlan();
  if (!plan) return;
  if (plan.name === "Plan") return; // the default plan is protected
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
    if (state.selection.listIndex >= plan.lists.length) state.selection.listIndex = Math.max(0, plan.lists.length - 1);
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
  if (state.selection.listIndex < 0) {
    const idx = resolvedListIndex();
    if (idx >= 0) { state.selection.listIndex = idx; state.selection.entryIndex = -1; }
  }
  body.dataset.view = body.dataset.view === "single" ? "multi" : "single";
  attachSortables();
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
  if (dx) {
    const n = plan.lists.length;
    let next = state.selection.listIndex + dx;
    // Wrap past the ends in both single- and multi-list views.
    next = ((next % n) + n) % n;
    state.selection.listIndex = next;
    const list = plan.lists[state.selection.listIndex];
    if (list && state.selection.entryIndex >= list.entries.length) state.selection.entryIndex = list.entries.length - 1;
  }
  if (dy) {
    const list = plan.lists[state.selection.listIndex];
    if (!list || list.entries.length === 0) { state.selection.entryIndex = -1; }
    else if (state.selection.entryIndex === -1) {
      // From the header: up jumps to the last entry, down to the first.
      state.selection.entryIndex = dy > 0 ? 0 : list.entries.length - 1;
    }
    else {
      const next = state.selection.entryIndex + dy;
      // Up off the first entry selects the header; down off the last wraps to top.
      if (next < 0) state.selection.entryIndex = -1;
      else if (next >= list.entries.length) state.selection.entryIndex = 0;
      else state.selection.entryIndex = next;
    }
  }
  render();
  scrollSelectionIntoView();
}

// shift+arrow: reorder the selected entry (or list if no entry is selected).
function shiftMove(dx, dy) {
  const plan = activePlan();
  if (!plan) return;
  const list = plan.lists[state.selection.listIndex];
  if (!list) return;

  if (state.selection.entryIndex >= 0) {
    const ei = state.selection.entryIndex;
    if (dy) {
      const n = list.entries.length;
      if (n < 2) return;
      pushHistory();
      // Wrap past the ends: moving up off the top sends the entry to the bottom, and vice versa.
      const ni = (ei + dy + n) % n;
      const [moved] = list.entries.splice(ei, 1);
      list.entries.splice(ni, 0, moved);
      state.selection.entryIndex = ni;
    } else if (dx) {
      const n = plan.lists.length;
      if (n < 2) return;
      // Wrap past the ends in both single- and multi-list views.
      const raw = state.selection.listIndex + dx;
      const ti = ((raw % n) + n) % n;
      pushHistory();
      const target = plan.lists[ti];
      const [moved] = list.entries.splice(ei, 1);
      const insertAt = Math.min(ei, target.entries.length);
      target.entries.splice(insertAt, 0, moved);
      state.selection.listIndex = ti;
      state.selection.entryIndex = insertAt;
    }
  } else if (dx) {
    const n = plan.lists.length;
    if (n < 2) return;
    const li = state.selection.listIndex;
    // Wrap past the ends in both single- and multi-list views.
    const raw = li + dx;
    const ni = ((raw % n) + n) % n;
    pushHistory();
    [plan.lists[li], plan.lists[ni]] = [plan.lists[ni], plan.lists[li]];
    state.selection.listIndex = ni;
  } else {
    return;
  }
  save(); render(); scrollSelectionIntoView();
}

function scrollSelectionIntoView() {
  const sec = board.querySelectorAll(".list")[state.selection.listIndex];
  if (sec) sec.scrollIntoView({ behavior: "instant", inline: "nearest", block: "nearest" });
  const sel = board.querySelector(".entry[data-selected]");
  if (sel) {
    const scroller = sel.closest(".entries");
    if (scroller) {
      const sRect = scroller.getBoundingClientRect();
      const eRect = sel.getBoundingClientRect();
      const target = scroller.scrollTop + (eRect.top - sRect.top) - (scroller.clientHeight / 2) + (eRect.height / 2);
      const max = scroller.scrollHeight - scroller.clientHeight;
      scroller.scrollTop = Math.max(0, Math.min(max, target));
    } else {
      sel.scrollIntoView({ behavior: "instant", block: "center" });
    }
  }
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
  const onSubmit = (e) => { e.preventDefault(); confirmed = true; dlg.close(); };
  const onKey = (e) => {
    if (e.key === "Enter") { e.preventDefault(); form.requestSubmit(); }
  };
  const onClose = () => {
    form.removeEventListener("submit", onSubmit);
    dlg.removeEventListener("keydown", onKey);
    dlg.removeEventListener("close", onClose);
    if (confirmed) onYes();
    setMode("normal");
  };
  form.addEventListener("submit", onSubmit);
  dlg.addEventListener("keydown", onKey);
  dlg.addEventListener("close", onClose);
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
  let highlighted = 0;
  setMode("palette");

  const matching = () => state.data.plans.filter((p) => !input.value || fuzzyMatch(input.value, p.name));
  // "<New plan>" is appended after all matches, at index matches.length.
  const refresh = () => {
    const matches = matching();
    const total = matches.length + 1;
    if (highlighted >= total) highlighted = total - 1;
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
    const newLi = document.createElement("li");
    newLi.textContent = "<New plan>";
    newLi.dataset.newPlan = "";
    if (highlighted === matches.length) newLi.dataset.active = "";
    fastTap(newLi, () => createNew());
    list.appendChild(newLi);
  };

  const pick = (planId) => {
    state.data.activePlanId = planId;
    state.selection = { listIndex: 0, entryIndex: -1 };
    save();
    cleanup(); dlg.close(); setMode("normal"); render();
  };

  const createNew = () => {
    const seed = input.value.trim();
    cleanup(); dlg.close(); setMode("normal"); openNewPlan(seed);
  };

  const onKey = (e) => {
    const matches = matching();
    const total = matches.length + 1;
    if (e.key === "ArrowDown") { e.preventDefault(); highlighted = Math.min(total - 1, highlighted + 1); refresh(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); highlighted = Math.max(0, highlighted - 1); refresh(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (highlighted === matches.length) { createNew(); return; }
      if (matches[highlighted]) pick(matches[highlighted].id);
    }
  };
  const onInput = () => { highlighted = 0; refresh(); };
  const onClose = () => { cleanup(); if (body.dataset.mode === "palette") setMode("normal"); };
  const cleanup = () => {
    input.removeEventListener("keydown", onKey);
    input.removeEventListener("input", onInput);
    dlg.removeEventListener("close", onClose);
  };
  input.addEventListener("keydown", onKey);
  input.addEventListener("input", onInput);
  dlg.addEventListener("close", onClose);
  refresh();
  dlg.showModal();
  input.focus();
}

function openNewPlan(seedName = "") {
  const dlg = $("new-plan");
  const input = $("new-plan-input");
  input.value = seedName;
  setMode("palette"); // reuse the modal-open state for the global key handler

  let created = false;
  const submit = () => {
    const name = input.value.trim();
    if (!name) return;
    pushHistory();
    const p = { id: uuid(), name, lists: [{ id: uuid(), name: "", entries: [] }] };
    state.data.plans.push(p);
    state.data.activePlanId = p.id;
    state.selection = { listIndex: 0, entryIndex: -1 };
    created = true;
    save();
    dlg.close();
  };
  const onKey = (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
  };
  const onSubmit = (e) => { e.preventDefault(); submit(); };
  const onClose = () => {
    cleanup();
    setMode("normal");
    if (created) { render(); editList(0, true); }
  };
  const cleanup = () => {
    input.removeEventListener("keydown", onKey);
    $("new-plan-form").removeEventListener("submit", onSubmit);
    dlg.removeEventListener("close", onClose);
  };
  input.addEventListener("keydown", onKey);
  $("new-plan-form").addEventListener("submit", onSubmit);
  dlg.addEventListener("close", onClose);
  dlg.showModal();
  input.focus();
  input.select();
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
  const onSubmit = (e) => { e.preventDefault(); submit(); };
  const onKey = (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } };
  const onClose = () => {
    form.removeEventListener("submit", onSubmit);
    input.removeEventListener("keydown", onKey);
    dlg.removeEventListener("close", onClose);
    setMode("normal");
    if (confirmed) render();
  };
  form.addEventListener("submit", onSubmit);
  input.addEventListener("keydown", onKey);
  dlg.addEventListener("close", onClose);
  dlg.showModal();
  input.focus();
}

// ---------- images ----------
// One image per entry. The blob stores only an id; the bytes live in R2 behind
// /api/img. The server owns deletion — it diffs every write and drops whatever
// the new blob no longer references — so the client's whole job is to keep the
// reference honest and never resurrect a dead one (see scrubHistory).
const IMG_MAX_DIM = 1600;
const IMG_MAX_BYTES = 10 * 1024 * 1024; // matches MAX_IMAGE_BYTES in src/images.ts
const IMG_TYPES = new Set(["image/webp", "image/png", "image/jpeg", "image/gif", "image/avif"]);
const imgUrl = (id) => `/api/img/${id}`;

// render() rebuilds the whole board on every keystroke; reusing the same <img>
// element per id means a repaint re-parents an already-decoded image instead of
// creating a fresh one that flashes while the browser re-reads its cache.
const imgCache = new Map();
const healing = new Set();
let uploads = 0;

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

function selectedEntryIds() {
  const plan = activePlan();
  const list = plan?.lists[state.selection.listIndex];
  const entry = list && state.selection.entryIndex >= 0 ? list.entries[state.selection.entryIndex] : null;
  return entry ? { listId: list.id, entryId: entry.id } : null;
}

function imgFor(id) {
  let el = imgCache.get(id);
  if (!el) {
    el = document.createElement("img");
    el.alt = "";
    el.draggable = false; // a native image drag would hijack Sortable's entry drag
    el.src = imgUrl(id);
    el.addEventListener("error", () => healBrokenImage(id));
    imgCache.set(id, el);
  }
  return el;
}

// A reference whose object is gone renders as a broken image forever, so drop
// it — but only on a confirmed 404. The same error event fires for a dropped
// connection, and discarding a live image over one lost packet is not
// recoverable.
async function healBrokenImage(id) {
  if (healing.has(id)) return;
  healing.add(id);
  try {
    const res = await fetch(imgUrl(id), { method: "HEAD", cache: "no-store" });
    if (res.status !== 404) { healing.delete(id); return; }
  } catch { healing.delete(id); return; }
  imgCache.delete(id);
  let changed = false;
  eachEntry(state.data, (e) => { if (e.image === id) { delete e.image; changed = true; } });
  if (changed) { save(); render(); }
}

// Downscale and re-encode before upload: a pasted screenshot is routinely 4MB
// of PNG that renders into a ~300px column. Returns null when nothing usable
// came out, so the caller can bail instead of uploading something the worker
// will reject.
async function encodeImage(file) {
  // A canvas round-trip flattens an animated GIF to its first frame.
  if (file.type === "image/gif") return file.size <= IMG_MAX_BYTES ? file : null;
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
  const original = IMG_TYPES.has(file.type) && file.size <= IMG_MAX_BYTES ? file : null;
  if (!out || !IMG_TYPES.has(out.type) || out.size > IMG_MAX_BYTES) return original;
  // Re-encoding a small image can make it bigger; keep whichever is smaller.
  return original && original.size <= out.size ? original : out;
}

async function attachImage(file, listId, entryId) {
  const blob = await encodeImage(file);
  if (!blob) return;
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

  pushHistory();
  found.entry.image = id;
  saveNow(); // get the reference to the server promptly — until it lands, the object is an orphan
  if (body.dataset.mode === "insert") {
    // Mid-edit: render() would tear out the live textarea, so patch the node.
    const li = board.querySelector(`.entry[data-entry-id="${entryId}"]`);
    if (li) { li.querySelector("img")?.remove(); li.appendChild(imgFor(id)); }
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
  return selectedEntryIds();
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
  $("img-view-img").src = imgUrl(found.entry.image);
  setMode("image");
  $("img-view").showModal();
}

// Clicking/tapping an entry's image opens it, and selects the entry so the
// preview's delete acts on something the board also shows as selected.
function openImageViewFromNode(imgEl) {
  const li = imgEl.closest(".entry");
  const sec = li?.closest(".list");
  if (!li || !sec) return;
  const plan = activePlan();
  const listIndex = plan.lists.findIndex((l) => l.id === sec.dataset.listId);
  if (listIndex < 0) return;
  const entryIndex = plan.lists[listIndex].entries.findIndex((en) => en.id === li.dataset.entryId);
  if (entryIndex < 0) return;
  state.selection.listIndex = listIndex;
  state.selection.entryIndex = entryIndex;
  render();
  openImageView(sec.dataset.listId, li.dataset.entryId);
}

(function setupImageView() {
  const dlg = $("img-view");
  const openTab = () => { if (imgView) window.open(imgUrl(imgView.id), "_blank", "noopener"); };
  const remove = () => {
    if (!imgView) return;
    const { listId, entryId } = imgView;
    dlg.close();
    detachImage(listId, entryId);
  };
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(); }
    else if (e.key === "n" || e.key === "N") { e.preventDefault(); openTab(); }
    // Escape closes natively.
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
// whole board. So single view only drops the entry selection; multi view (only
// reachable on desktop) fully deselects.
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

// Desktop deselects on click: a drag-to-scroll moves the pointer and fires no
// click, so the selection survives scrolling. Touch deselects on pointerdown for
// instant feedback (see setupTouch).
board.addEventListener("click", (e) => {
  if (state.isTouch) return;
  if (body.dataset.mode !== "normal") return;
  if (e.target.closest(".list")) return;
  deselectOutside();
});

// ---------- desktop click-to-edit ----------
board.addEventListener("click", (e) => {
  if (state.isTouch) return;
  if (body.dataset.mode !== "normal") return;
  if (e.target.matches(".entry img")) { openImageViewFromNode(e.target); return; }
  const entry = e.target.closest(".entry");
  if (!entry) return;
  const sec = entry.closest(".list");
  const li = [...board.querySelectorAll(".list")].indexOf(sec);
  const ei = [...sec.querySelectorAll(".entry")].indexOf(entry);
  state.selection.listIndex = li;
  state.selection.entryIndex = ei;
  render();
  const fresh = board.querySelectorAll(".list")[li].querySelectorAll(".entry")[ei];
  editEntry(li, ei, false, caretOffsetFromPoint(e.clientX, e.clientY, fresh));
});

// ---------- mouse drag-to-scroll (desktop) ----------
(function setupDragScroll() {
  let drag = null;
  board.addEventListener("pointerdown", (e) => {
    if (state.isTouch || e.button !== 0) return;
    if (e.target.closest(".entry") || e.target.closest(".list-name")) return;
    const ul = e.target.closest(".entries");
    const scroller = ul || board;
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
    if (drag?.moved) board.releasePointerCapture(drag.pid);
    // Single-list desktop view: a horizontal drag on empty board area cycles lists.
    if (drag && drag.moved && body.dataset.view === "single" && !state.isTouch && drag.scroller === board) {
      const dx = e?.clientX != null ? e.clientX - drag.x : 0;
      const dy = e?.clientY != null ? e.clientY - drag.y : 0;
      if (Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy)) move(dx < 0 ? 1 : -1, 0);
    }
    drag = null;
    body.classList.remove("dragging-scroll");
  };
  board.addEventListener("pointerup", end);
  board.addEventListener("pointercancel", end);
})();

// ---------- keyboard ----------
document.addEventListener("keydown", (e) => {
  if (body.dataset.mode !== "normal") return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.ctrlKey && !e.altKey && (e.key === "c" || e.key === "C")) {
    const list = activePlan().lists[state.selection.listIndex];
    const entry = list && state.selection.entryIndex >= 0 ? list.entries[state.selection.entryIndex] : null;
    if (entry) { e.preventDefault(); navigator.clipboard?.writeText(entry.text); }
    return;
  }
  if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
    e.preventDefault(); undo(); return;
  }
  // Ctrl+Shift+V — remove the selected entry's image. Normal mode only, so it
  // doesn't shadow paste-as-plain-text while editing.
  if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === "v" || e.key === "V")) {
    e.preventDefault();
    const sel = selectedEntryIds();
    if (sel) detachImage(sel.listId, sel.entryId);
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return; // let browser shortcuts (Ctrl+R, etc.) through
  if (e.key !== "Enter") state.chainArmed = false; // anything but a straight Enter run ends the burst

  switch (e.key) {
    case "ArrowUp": case "k": case "K":    e.preventDefault(); (e.shiftKey ? shiftMove : move)(0, -1); break;
    case "ArrowDown": case "j": case "J":  e.preventDefault(); (e.shiftKey ? shiftMove : move)(0,  1); break;
    case "ArrowLeft": case "h": case "H":  e.preventDefault(); (e.shiftKey ? shiftMove : move)(-1, 0); break;
    case "ArrowRight": case "l": case "L": e.preventDefault(); (e.shiftKey ? shiftMove : move)( 1, 0); break;
    case "Enter":      e.preventDefault(); newEntryBelow(); break;
    case "Delete":
    case "Backspace":
      e.preventDefault();
      if (state.selection.entryIndex >= 0) deleteEntry();
      else deleteCurrentList();
      break;
    case "Escape": {
      e.preventDefault();
      state.selection.entryIndex = -1;
      render(); scrollSelectionIntoView();
      break;
    }
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
      const sel = selectedEntryIds();
      if (sel) openImageView(sel.listId, sel.entryId);
      break;
    }
    case " ": e.preventDefault(); openPalette(); break;
    case "v":
      if (state.isTouch) break;
      e.preventDefault();
      toggleView();
      break;
  }
});

// Open an entry / list header for editing by id, resolving indices against the
// *current* data — safe to call right after a commit re-rendered the board (the
// tapped DOM node is stale by then, but its id still points at live data).
function editEntryById(listId, entryId, x, y) {
  const plan = activePlan();
  const li = plan.lists.findIndex((l) => l.id === listId);
  if (li < 0) return;
  const ei = plan.lists[li].entries.findIndex((en) => en.id === entryId);
  if (ei < 0) return;
  state.selection.listIndex = li;
  state.selection.entryIndex = ei;
  render();
  const fresh = board.querySelectorAll(".list")[li]?.querySelectorAll(".entry")[ei];
  if (fresh) editEntry(li, ei, false, caretOffsetFromPoint(x, y, fresh));
}
function editListById(listId) {
  const plan = activePlan();
  const li = plan.lists.findIndex((l) => l.id === listId);
  if (li < 0) return;
  state.selection.listIndex = li;
  state.selection.entryIndex = -1;
  render();
  editList(li);
}

// ---------- touch ----------
function setupTouch() {
  if (!state.isTouch) return;
  body.classList.add("touch");
  body.dataset.view = "single";

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
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) active.blur(); // commit + hide keyboard
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
      const editing = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA");
      if (editing && active.contains(e.target)) return;
      const target = editing ? editTargetFrom(e, active) : null;
      // A mouse on a touch-capable device fires no touchend — decide on press.
      if (e.pointerType !== "touch") { dismissEdit(true, target, e.clientX, e.clientY); return; }
      if (!dismiss) dismiss = { x: e.clientX, y: e.clientY, target }; // extra fingers ride the first one
      return;
    }
    if (e.target.closest(".list")) return; // a real target handles its own tap
    if (body.dataset.mode !== "normal") return;
    deselectOutside();
  }, true);

  // Opening an editor stays on `click`: the native click is what makes mobile
  // browsers draw the caret and raise the keyboard for a programmatic focus().
  // Firing our own focus() on pointerup instead left the caret invisible. The
  // click handler still runs right after the tap, and a scroll/drag fires no
  // click, so it only triggers on a genuine tap.
  board.addEventListener("click", (e) => {
    if (body.dataset.mode !== "normal") return; // already editing — let the field handle the tap
    if (e.target.matches(".entry img")) { openImageViewFromNode(e.target); return; }
    const name = e.target.closest(".list-name");
    if (name) {
      const sec = name.closest(".list");
      const li = [...board.querySelectorAll(".list")].indexOf(sec);
      if (li < 0) return;
      state.selection.listIndex = li;
      state.selection.entryIndex = -1;
      render();
      editList(li);
      return;
    }

    const entry = e.target.closest(".entry");
    if (!entry) return;
    const sec = entry.closest(".list");
    const li = [...board.querySelectorAll(".list")].indexOf(sec);
    const ei = [...sec.querySelectorAll(".entry")].indexOf(entry);
    if (li < 0 || ei < 0) return; // stale node from a re-render — ignore
    state.selection.listIndex = li; state.selection.entryIndex = ei;
    render();
    const fresh = board.querySelectorAll(".list")[li].querySelectorAll(".entry")[ei];
    editEntry(li, ei, false, caretOffsetFromPoint(e.clientX, e.clientY, fresh));
  });

  let touchStart = null;
  board.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { passive: true });
  board.addEventListener("touchend", (e) => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x, dy = t.clientY - touchStart.y;
    touchStart = null;
    // Single-list view: swipe cycles lists. Plan switching on mobile is
    // deliberate-only, via the plan-name button → palette.
    if (body.dataset.view !== "single") return;
    // While editing an entry, selecting text drags the finger across the field —
    // don't read that as a list-switch swipe.
    if (body.dataset.mode === "insert") return;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) move(dx < 0 ? 1 : -1, 0);
  });

  // Chrome buttons fire on pointerdown so they respond the instant they're
  // pressed instead of waiting for the synthetic click on release. preventDefault
  // keeps the press from also producing a delayed click that would fire twice.
  const onPress = (el, fn) => el.addEventListener("pointerdown", (e) => { e.preventDefault(); fn(e); });

  onPress($("nav-toggle"), () => body.classList.toggle("nav-open"));

  onPress($("actions"), (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    ({
      "del-plan": deleteCurrentPlan,
      "new-list": newList,
      "del-list": deleteCurrentList,
      "toggle-todo": toggleTodo
    })[act]?.();
  });
  onPress($("m-palette"), openPalette);
  onPress($("m-view"), toggleView);
}

// Backdrop click closes a dialog (mobile expectation).
["palette", "new-plan", "confirm", "bg"].forEach((id) => attachBackdropClose($(id)));

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

// ---------- auth + boot ----------
// Turnstile is only needed in the auth dialog, so load it on demand — the common
// authed load then makes no connection to challenges.cloudflare.com.
let turnstileLoaded = false;
function loadTurnstile() {
  if (turnstileLoaded) { window.turnstile?.reset(); return; }
  turnstileLoaded = true;
  const s = document.createElement("script");
  s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
  s.async = true; s.defer = true;
  document.head.appendChild(s);
}

function showAuth() {
  const dlg = $("auth");
  const form = $("auth-form");
  const input = $("auth-input");
  const err = $("auth-error");
  loadTurnstile();
  dlg.showModal();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;

    const token = form.querySelector('[name="cf-turnstile-response"]')?.value || "";
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: input.value, turnstile: token })
    });
    if (res.ok) { dlg.close(); await loadData(); }
    // Any failure consumes the token, so reset the widget for a fresh one.
    else { err.hidden = false; input.select(); window.turnstile?.reset(); }
  });
}

async function loadData() {
  const res = await fetch("/api/data");
  if (!res.ok) { showAuth(); return; }
  state.data = await res.json();
  if (state.isTouch || innerWidth < 600) body.dataset.view = "single";
  setupTouch();
  render();
  board.focus();
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
async function refresh() {
  if (!state.data.plans.length) return; // not booted yet
  if (savePending || uploads > 0 || body.dataset.mode === "insert") return;
  let res;
  try { res = await fetch("/api/data", { cache: "no-store" }); } catch { return; }
  if (!res.ok) return;
  const remote = await res.json();
  if (remote.version !== state.data.version) applyRemote(remote);
}

window.addEventListener("focus", refresh);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh();
});

// An in-flight upload is guarded too: leaving before its reference is saved
// would strand the object in R2 until the server's next sweep.
window.addEventListener("beforeunload", (e) => {
  if (savePending || uploads > 0) { e.preventDefault(); e.returnValue = ""; }
});

// /api/data 401s when unauthed and loadData() falls back to showAuth(), so we
// boot in a single round-trip with no separate auth probe.
loadData();
