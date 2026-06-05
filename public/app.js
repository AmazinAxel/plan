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
  await fetch("/api/data", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.data),
  });
}
function save() {
  savePending = true;
  if (saveTimer) return;
  const wait = Math.max(0, SAVE_INTERVAL - (Date.now() - lastSaveAt));
  saveTimer = setTimeout(flushSave, wait);
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
function editList(listIndex) {
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
  const commit = () => {
    list.name = input.value.trim();
    save();
    setMode("normal"); render();
    if (list.entries.length === 0) newEntryBelow();
  };
  let cancelled = false;
  input.addEventListener("blur", () => { if (!cancelled) commit(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); cancelled = true; setMode("normal"); render(); }
    e.stopPropagation();
  });
}

function editEntry(listIndex, entryIndex) {
  const plan = activePlan();
  const list = plan.lists[listIndex];
  if (!list) return;
  const entry = list.entries[entryIndex];
  if (!entry) return;
  setMode("insert");
  const sec = board.querySelectorAll(".list")[listIndex];
  const it = sec.querySelectorAll(".entry")[entryIndex];
  it.textContent = "";
  const input = document.createElement("input");
  input.value = entry.text;
  it.appendChild(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  let cancelled = false;
  let chain = false;
  const commit = () => {
    const v = input.value.trim();
    if (v) entry.text = v;
    else list.entries.splice(entryIndex, 1);
    save();
    setMode("normal"); render();
    if (chain && state.isTouch && v) newEntryBelow();
  };
  input.addEventListener("blur", () => { if (!cancelled) commit(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); chain = true; input.blur(); }
    else if (e.key === "Escape") {
      e.preventDefault(); cancelled = true;
      if (!entry.text) list.entries.splice(entryIndex, 1);
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
  editList(state.selection.listIndex);
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
  editEntry(state.selection.listIndex, at);
}

function deleteEntry() {
  const plan = activePlan();
  const list = plan.lists[state.selection.listIndex];
  if (!list || state.selection.entryIndex < 0) return;
  list.entries.splice(state.selection.entryIndex, 1);
  if (state.selection.entryIndex >= list.entries.length) state.selection.entryIndex = list.entries.length - 1;
  save(); render();
}

function deleteCurrentPlan() {
  const plan = activePlan();
  if (!plan) return;
  if (plan.name === "Plan") return; // protected
  confirmModal(`delete plan "${plan.name || "—"}"?`, () => {
    state.data.plans = state.data.plans.filter((p) => p.id !== plan.id);
    state.data.activePlanId = state.data.plans[0].id;
    state.selection = { listIndex: 0, entryIndex: -1 };
    save(); render();
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
    save(); render();
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
  if (sel) sel.scrollIntoView({ behavior: "instant", block: "nearest" });
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
  const refresh = () => {
    const matches = matching();
    if (highlighted >= matches.length) highlighted = Math.max(0, matches.length - 1);
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
  };

  const pick = (planId) => {
    state.data.activePlanId = planId;
    state.selection = { listIndex: 0, entryIndex: -1 };
    save();
    cleanup(); dlg.close(); setMode("normal"); render();
  };

  const onKey = (e) => {
    const matches = matching();
    if (e.key === "ArrowDown") { e.preventDefault(); highlighted = Math.min(matches.length - 1, highlighted + 1); refresh(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); highlighted = Math.max(0, highlighted - 1); refresh(); }
    else if (e.key === "Enter") {
      e.preventDefault();
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

function openNewPlan() {
  const dlg = $("new-plan");
  const input = $("new-plan-input");
  input.value = "";
  setMode("palette"); // same "modal-open" state for the global key handler

  let created = false;
  const submit = () => {
    const name = input.value.trim();
    if (!name) return;
    const p = { id: uuid(), name, lists: [] };
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
    if (created) render();
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
  const end = () => { if (drag?.moved) board.releasePointerCapture(drag.pid); drag = null; body.classList.remove("dragging-scroll"); };
  board.addEventListener("pointerup", end);
  board.addEventListener("pointercancel", end);
})();

// ---------- keyboard ----------
document.addEventListener("keydown", (e) => {
  if (body.dataset.mode !== "normal") return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

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
    case "n": e.preventDefault(); newList(); break;
    case "m": e.preventDefault(); openNewPlan(); break;
    case "e":
      e.preventDefault();
      if (state.selection.entryIndex >= 0) editEntry(state.selection.listIndex, state.selection.entryIndex);
      else editList(state.selection.listIndex);
      break;
    case "r": e.preventDefault(); deleteCurrentPlan(); break;
    case ":": e.preventDefault(); openPalette(); break;
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

  // tap a list's header → select that list (entryIndex = -1)
  board.addEventListener("click", (e) => {
    const name = e.target.closest(".list-name");
    if (!name) return;
    const sec = name.closest(".list");
    const li = [...board.querySelectorAll(".list")].indexOf(sec);
    if (li < 0) return;
    state.selection.listIndex = li;
    state.selection.entryIndex = -1;
    render();
  });

  let lastTap = { id: null, time: 0 };
  board.addEventListener("click", (e) => {
    const entry = e.target.closest(".entry");
    if (!entry) return;
    const sec = entry.closest(".list");
    const li = [...board.querySelectorAll(".list")].indexOf(sec);
    const ei = [...sec.querySelectorAll(".entry")].indexOf(entry);
    state.selection.listIndex = li; state.selection.entryIndex = ei;
    const now = Date.now();
    if (lastTap.id === entry.dataset.entryId && now - lastTap.time < 300) {
      editEntry(li, ei); lastTap = { id: null, time: 0 };
    } else { lastTap = { id: entry.dataset.entryId, time: now }; render(); }
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
    // only switch lists by swipe in single-list view; in multi view the user is panning the board.
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
      "edit-list": () => editList(state.selection.listIndex),
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
["palette", "new-plan", "confirm"].forEach((id) => attachBackdropClose($(id)));

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
  if (state.isTouch) body.dataset.view = "single";
  setupTouch();
  render();
  board.focus();
}

window.addEventListener("beforeunload", (e) => {
  if (savePending) { e.preventDefault(); e.returnValue = ""; }
});

boot();
