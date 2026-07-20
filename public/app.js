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
  viewedListId: null
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
  const cleaned = JSON.parse(JSON.stringify(state.data));
  cleaned.plans.forEach((p) => p.lists.forEach((l) => {
    l.entries = l.entries.filter((e) => e.text && e.text.trim());
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
  savePending = true;
  if (saveTimer) return;
  const wait = Math.max(0, SAVE_INTERVAL - (Date.now() - lastSaveAt));
  saveTimer = setTimeout(flushSave, wait);
}
function saveNow() {
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
  const sec = board.querySelectorAll(".list")[listIndex];
  const nameEl = sec.querySelector(".list-name");
  nameEl.textContent = "";
  const input = document.createElement("input");
  input.value = list.name;
  nameEl.appendChild(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  const stopKeep = keepFocusOnTabSwitch(input);
  const commit = () => {
    stopKeep();
    const v = input.value.trim();
    if (!isNew && v !== list.name) pushHistory();
    list.name = v;
    save();
    setMode("normal"); render();
    if (list.entries.length === 0) newEntryBelow();
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
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); cancelled = true; cancel(); }
    e.stopPropagation();
  });
}

function editEntry(listIndex, entryIndex, isNew = false) {
  const plan = activePlan();
  const list = plan.lists[listIndex];
  if (!list) return;
  const entry = list.entries[entryIndex];
  if (!entry) return;
  setMode("insert");
  const sec = board.querySelectorAll(".list")[listIndex];
  const it = sec.querySelectorAll(".entry")[entryIndex];
  it.textContent = "";
  const input = document.createElement("textarea");
  input.value = entry.text;
  input.rows = 1;
  it.appendChild(input);
  const resize = () => { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; };
  input.addEventListener("input", resize);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  resize();
  const stopKeep = keepFocusOnTabSwitch(input);
  let cancelled = false;
  let chain = false;
  const commit = () => {
    stopKeep();
    const v = input.value.trim();
    if (isNew) { if (!v) popHistory(); } // abandoned new entry — discard its snapshot
    else if (v !== entry.text) pushHistory();
    if (v) entry.text = v;
    else list.entries.splice(entryIndex, 1);
    // Mobile: once a new entry has been saved in this list, later entries chain.
    if (isNew && v) state.firstEntryMade = true;
    save();
    setMode("normal"); render();
    if (chain && v) newEntryBelow();
  };
  input.addEventListener("blur", () => { if (!cancelled) commit(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // Desktop: only new entries chain. Mobile: a new entry chains only after
      // the first one has been made (the first saves-and-stops); editing an
      // existing entry chains only when left unmodified — Enter after an edit
      // just commits, but Enter on an untouched entry adds a new one.
      const modified = input.value.trim() !== entry.text;
      chain = state.isTouch ? (isNew ? state.firstEntryMade : !modified) : isNew;
      input.blur();
    }
    else if (e.key === "Escape") {
      e.preventDefault(); cancelled = true; stopKeep();
      if (!entry.text) { list.entries.splice(entryIndex, 1); if (isNew) popHistory(); save(); }
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

function newEntryBelow() {
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
  editEntry(state.selection.listIndex, at, true);
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

function deleteCurrentList() {
  const plan = activePlan();
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

// ---------- navigation ----------
// entryIndex === -1 means the list itself is selected (not any entry).
function move(dx, dy) {
  const plan = activePlan();
  if (!plan || plan.lists.length === 0) return;
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
function attachBackdropClose(dlg) {
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
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
      li.addEventListener("click", () => pick(p.id));
      list.appendChild(li);
    });
    const newLi = document.createElement("li");
    newLi.textContent = "<New plan>";
    newLi.dataset.newPlan = "";
    if (highlighted === matches.length) newLi.dataset.active = "";
    newLi.addEventListener("click", () => createNew());
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

// ---------- desktop click-to-edit ----------
board.addEventListener("click", (e) => {
  if (state.isTouch) return;
  if (body.dataset.mode !== "normal") return;
  const entry = e.target.closest(".entry");
  if (!entry) return;
  const sec = entry.closest(".list");
  const li = [...board.querySelectorAll(".list")].indexOf(sec);
  const ei = [...sec.querySelectorAll(".entry")].indexOf(entry);
  state.selection.listIndex = li;
  state.selection.entryIndex = ei;
  render();
  editEntry(li, ei);
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
  if (e.ctrlKey || e.metaKey || e.altKey) return; // let browser shortcuts (Ctrl+R, etc.) through

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
    case " ": e.preventDefault(); openPalette(); break;
    case "v":
      if (state.isTouch) break;
      e.preventDefault();
      body.dataset.view = body.dataset.view === "single" ? "multi" : "single";
      attachSortables();
      render();
      break;
  }
});

// ---------- touch ----------
function setupTouch() {
  if (!state.isTouch) return;
  body.classList.add("touch");
  body.dataset.view = "single";

  board.addEventListener("click", (e) => { if (e.target === board) setMode("normal"); });

  board.addEventListener("click", (e) => {
    if (body.dataset.mode !== "normal") return; // already editing — let the field handle the tap
    const name = e.target.closest(".list-name");
    if (!name) return;
    const sec = name.closest(".list");
    const li = [...board.querySelectorAll(".list")].indexOf(sec);
    if (li < 0) return;
    state.selection.listIndex = li;
    state.selection.entryIndex = -1;
    render();
    editList(li);
  });

  board.addEventListener("click", (e) => {
    if (body.dataset.mode !== "normal") return; // already editing — let the field handle the tap
    const entry = e.target.closest(".entry");
    if (!entry) return;
    const sec = entry.closest(".list");
    const li = [...board.querySelectorAll(".list")].indexOf(sec);
    const ei = [...sec.querySelectorAll(".entry")].indexOf(entry);
    state.selection.listIndex = li; state.selection.entryIndex = ei;
    render();
    editEntry(li, ei);
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

  $("nav-toggle").addEventListener("click", () => {
    body.classList.toggle("nav-open");
  });

  $("actions").addEventListener("click", (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    ({
      "del-plan": deleteCurrentPlan,
      "new-list": newList,
      "del-list": deleteCurrentList,
      "toggle-todo": toggleTodo
    })[act]?.();
  });
  $("m-palette").addEventListener("click", openPalette);
  $("m-view").addEventListener("click", () => {
    body.dataset.view = body.dataset.view === "single" ? "multi" : "single";
    attachSortables(); render();
  });
}

// Backdrop click closes a dialog (mobile expectation).
["palette", "new-plan", "confirm", "bg"].forEach((id) => attachBackdropClose($(id)));

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
  if (savePending || body.dataset.mode === "insert") return;
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

window.addEventListener("beforeunload", (e) => {
  if (savePending) { e.preventDefault(); e.returnValue = ""; }
});

// /api/data 401s when unauthed and loadData() falls back to showAuth(), so we
// boot in a single round-trip with no separate auth probe.
loadData();
