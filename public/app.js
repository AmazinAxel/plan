// Plan — keyboard-driven planning app. See AGENTS.md for the operating manual.

const $ = (id) => document.getElementById(id);
const body = document.body;
const board = $("board");

const state = {
  data: { activePlanId: "", plans: [] },
  selection: { listIndex: 0, entryIndex: -1 },
  isTouch: matchMedia("(hover: none) and (pointer: coarse)").matches
    || /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent),
};

const uuid = () => crypto.randomUUID();
const activePlan = () =>
  state.data.plans.find((p) => p.id === state.data.activePlanId) || state.data.plans[0];

// ---------- persistence ----------
// Throttled to one fetch per SAVE_INTERVAL ms. Mutations call save() freely;
// beforeunload guards against losing a pending write.
const SAVE_INTERVAL = 5000;
let saveTimer = null;
let savePending = false;
let lastSaveAt = 0;

async function flushSave() {
  saveTimer = null;
  if (!savePending) return;
  savePending = false;
  lastSaveAt = Date.now();
  // Strip whitespace-only entries before persisting. We do this on a clone so
  // an entry currently being edited (with empty initial text) stays in memory.
  const cleaned = JSON.parse(JSON.stringify(state.data));
  cleaned.plans.forEach((p) => p.lists.forEach((l) => {
    l.entries = l.entries.filter((e) => e.text && e.text.trim());
  }));
  await fetch("/api/data", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cleaned),
  });
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

// ---------- mode ----------
function setMode(mode) { body.dataset.mode = mode; }

// ---------- render ----------
function render() {
  const plan = activePlan();
  if (!plan) { board.innerHTML = ""; return; }

  if (state.selection.listIndex >= plan.lists.length) state.selection.listIndex = Math.max(0, plan.lists.length - 1);
  const list = plan.lists[state.selection.listIndex];
  if (list && state.selection.entryIndex >= list.entries.length) state.selection.entryIndex = list.entries.length - 1;

  board.innerHTML = "";
  plan.lists.forEach((l, li) => {
    const el = document.createElement("section");
    el.className = "list";
    el.dataset.listId = l.id;
    if (li === state.selection.listIndex) {
      el.dataset.selected = ""; el.dataset.active = "";
      if (state.selection.entryIndex === -1) el.dataset.listSelected = "";
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
      if (/^-{3,}(\s.*\s-{3,})?$/.test(e.text)) it.dataset.sep = "";
      if (e.todo) it.dataset.todo = "";
      if (li === state.selection.listIndex && ei === state.selection.entryIndex) it.dataset.selected = "";
      ul.appendChild(it);
    });
    el.appendChild(ul);
    board.appendChild(el);
  });

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
function attachSortables() {
  destroySortables();
  const plan = activePlan();
  if (!plan) return;
  const singleView = body.dataset.view === "single";

  sortables.push(Sortable.create(board, {
    group: "lists",
    animation: 120,
    draggable: ".list",
    filter: ".entries, .list-name input, .entry input",
    preventOnFilter: false,
    onStart: () => body.classList.add("dragging"),
    onEnd: (ev) => {
      body.classList.remove("dragging");
      if (ev.oldIndex === ev.newIndex) return;
      const moved = plan.lists.splice(ev.oldIndex, 1)[0];
      plan.lists.splice(ev.newIndex, 0, moved);
      state.selection.listIndex = ev.newIndex;
      save(); render();
    },
  }));

  board.querySelectorAll(".entries").forEach((ul) => {
    sortables.push(Sortable.create(ul, {
      group: { name: "entries", pull: !singleView, put: !singleView },
      animation: 120,
      draggable: ".entry",
      // On touch devices, require a brief hold before dragging starts. This lets
      // a quick vertical swipe scroll the list instead of latching onto an entry.
      delay: 250,
      delayOnTouchOnly: true,
      touchStartThreshold: 5,
      onStart: () => body.classList.add("dragging"),
      onEnd: (ev) => {
        body.classList.remove("dragging");
        const fromList = plan.lists.find((l) => l.id === ev.from.dataset.listId);
        const toList = plan.lists.find((l) => l.id === ev.to.dataset.listId);
        if (!fromList || !toList) return;
        const [moved] = fromList.entries.splice(ev.oldIndex, 1);
        toList.entries.splice(ev.newIndex, 0, moved);
        state.selection.listIndex = plan.lists.indexOf(toList);
        state.selection.entryIndex = ev.newIndex;
        save(); render();
      },
    }));
  });
}

// ---------- editing ----------
// If the tab/window loses focus while editing, defer the commit until it
// returns instead of dropping the in-flight text.
function keepFocusOnTabSwitch(input) {
  const onBlur = (e) => {
    if (document.hasFocus()) return; // a real interactive blur — let the caller's handler commit
    e.stopImmediatePropagation();
    const onFocus = () => {
      window.removeEventListener("focus", onFocus);
      if (document.body.dataset.mode === "insert") input.focus();
    };
    window.addEventListener("focus", onFocus);
  };
  input.addEventListener("blur", onBlur, true); // capture-phase, runs before commit handler
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
    list.name = input.value.trim();
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
    if (v) entry.text = v;
    else list.entries.splice(entryIndex, 1);
    save();
    setMode("normal"); render();
    if (chain && v && isNew) newEntryBelow();
  };
  input.addEventListener("blur", () => { if (!cancelled) commit(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); chain = true; input.blur(); }
    else if (e.key === "Escape") {
      e.preventDefault(); cancelled = true; stopKeep();
      if (!entry.text) { list.entries.splice(entryIndex, 1); save(); }
      setMode("normal"); render();
    }
    e.stopPropagation();
  });
}

// ---------- actions ----------
function newList() {
  const plan = activePlan();
  plan.lists.push({ id: uuid(), name: "", entries: [] });
  state.selection.listIndex = plan.lists.length - 1;
  state.selection.entryIndex = -1;
  save();
  render();
  editList(state.selection.listIndex, true);
}

function switchPlan(dir) {
  if (state.data.plans.length < 2) return;
  const idx = state.data.plans.findIndex((p) => p.id === state.data.activePlanId);
  const next = Math.max(0, Math.min(state.data.plans.length - 1, idx + dir));
  if (next === idx) return;
  state.data.activePlanId = state.data.plans[next].id;
  state.selection = { listIndex: 0, entryIndex: -1 };
  save();
  render();
}

function newEntryBelow() {
  const plan = activePlan();
  const list = plan.lists[state.selection.listIndex];
  if (!list) return;
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
  if (entry.todo) {
    delete entry.todo;
  } else {
    // Only one todo per list — clear any other before marking this one.
    list.entries.forEach((x) => { delete x.todo; });
    entry.todo = true;
  }
  save(); render();
}

function deleteEntry() {
  const plan = activePlan();
  const list = plan.lists[state.selection.listIndex];
  if (!list || state.selection.entryIndex < 0) return;
  list.entries.splice(state.selection.entryIndex, 1);
  if (state.selection.entryIndex >= list.entries.length) state.selection.entryIndex = list.entries.length - 1;
  saveNow(); render();
}

function deleteCurrentPlan() {
  const plan = activePlan();
  if (!plan) return;
  if (plan.name === "Plan") return; // protected
  confirmModal(`delete plan "${plan.name || "—"}"?`, () => {
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
    state.selection.listIndex = Math.max(0, Math.min(plan.lists.length - 1, state.selection.listIndex + dx));
    const list = plan.lists[state.selection.listIndex];
    if (list && state.selection.entryIndex >= list.entries.length) state.selection.entryIndex = list.entries.length - 1;
  }
  if (dy) {
    const list = plan.lists[state.selection.listIndex];
    if (!list || list.entries.length === 0) { state.selection.entryIndex = -1; }
    else if (state.selection.entryIndex === -1) {
      // Coming from the list header: up jumps to the last entry, down to the first.
      state.selection.entryIndex = dy > 0 ? 0 : list.entries.length - 1;
    }
    else {
      const next = state.selection.entryIndex + dy;
      state.selection.entryIndex = (next < 0 || next >= list.entries.length) ? -1 : next;
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
      const ni = ei + dy;
      if (ni < 0 || ni >= list.entries.length) return;
      [list.entries[ei], list.entries[ni]] = [list.entries[ni], list.entries[ei]];
      state.selection.entryIndex = ni;
    } else if (dx) {
      const ti = state.selection.listIndex + dx;
      if (ti < 0 || ti >= plan.lists.length) return;
      const target = plan.lists[ti];
      const [moved] = list.entries.splice(ei, 1);
      const insertAt = Math.min(ei, target.entries.length);
      target.entries.splice(insertAt, 0, moved);
      state.selection.listIndex = ti;
      state.selection.entryIndex = insertAt;
    }
  } else if (dx) {
    const li = state.selection.listIndex;
    const ni = li + dx;
    if (ni < 0 || ni >= plan.lists.length) return;
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
      const target = sel.offsetTop - (scroller.clientHeight / 2) + (sel.offsetHeight / 2);
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
  // The "<New plan>" row is appended after all matches, at index `matches.length`.
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
  setMode("palette"); // same "modal-open" state for the global key handler

  let created = false;
  const submit = () => {
    const name = input.value.trim();
    if (!name) return;
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
    // single-list desktop view: a horizontal pointer drag on empty board area cycles lists
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
  if (e.ctrlKey || e.metaKey || e.altKey) return; // let browser shortcuts (Ctrl+R, etc.) through

  switch (e.key) {
    case "ArrowUp":    e.preventDefault(); (e.shiftKey ? shiftMove : move)(0, -1); break;
    case "ArrowDown":  e.preventDefault(); (e.shiftKey ? shiftMove : move)(0,  1); break;
    case "ArrowLeft":  e.preventDefault(); (e.shiftKey ? shiftMove : move)(-1, 0); break;
    case "ArrowRight": e.preventDefault(); (e.shiftKey ? shiftMove : move)( 1, 0); break;
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
    // In single-list view, swipe cycles through LISTS in the current plan.
    // Plan switching on mobile is intentional only — via the plan-name button → palette.
    if (body.dataset.view !== "single") return;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) move(dx < 0 ? 1 : -1, 0);
  });

  $("actions").addEventListener("click", (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    ({
      "new-plan": openNewPlan,
      "del-plan": deleteCurrentPlan,
      "new-list": newList,
      "del-list": deleteCurrentList,
      "new-entry": newEntryBelow,
    })[act]?.();
  });
  $("m-palette").addEventListener("click", openPalette);
  $("m-view").addEventListener("click", () => {
    body.dataset.view = body.dataset.view === "single" ? "multi" : "single";
    attachSortables(); render();
  });
}

// dialog backdrop click closes (mobile expectation)
["palette", "new-plan", "confirm", "bg"].forEach((id) => attachBackdropClose($(id)));

// ---------- auth + boot ----------
async function boot() {
  const me = await fetch("/api/me");
  if (me.status === 401) { showAuth(); return; }
  await loadData();
}

function showAuth() {
  const dlg = $("auth");
  const form = $("auth-form");
  const input = $("auth-input");
  const err = $("auth-error");
  dlg.showModal();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: input.value }),
    });
    if (res.ok) { dlg.close(); await loadData(); }
    else { err.hidden = false; input.select(); }
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

window.addEventListener("beforeunload", (e) => {
  if (savePending) { e.preventDefault(); e.returnValue = ""; }
});

boot();
