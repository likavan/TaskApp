/* ---------- API helper ---------- */
const api = {
  async req(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      showLogin();
      throw new Error('unauth');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `${res.status} ${res.statusText}`);
    }
    return res.status === 204 ? null : res.json();
  },
  get: (p) => api.req('GET', p),
  post: (p, b) => api.req('POST', p, b),
  patch: (p, b) => api.req('PATCH', p, b),
  del: (p) => api.req('DELETE', p),
};

/* ---------- Stav v pamäti ---------- */
let running = null; // aktuálne bežiaci záznam
let serverSkew = 0; // rozdiel medzi serverom a klientom (ms)
let projects = [];
let todayTotals = {}; // project_id -> ms (dnes)
let historyRange = 'today';
let kimaiEnabled = false;
let kimaiProjects = null; // cache zoznamu Kimai projektov

const $ = (id) => document.getElementById(id);
const now = () => Date.now() + serverSkew;

// Klasická „settings" SVG ikona (čiarková, dedí currentColor).
const GEAR_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

/* ---------- Formátovanie ---------- */
function fmtShort(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString('sk-SK', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Hranice rozsahu v časovom pásme prehliadača — server môže bežať v UTC.
function rangeBounds(range) {
  const d = new Date();
  const to = Date.now();
  if (range === 'week') {
    const day = (d.getDay() + 6) % 7; // pondelok = 0
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
    return { from: start.getTime(), to };
  }
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return { from: start.getTime(), to };
}
const rangeQuery = (range) => {
  const { from, to } = rangeBounds(range);
  return `from=${from}&to=${to}`;
};

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 1800);
}

/* ---------- Vykreslenie stavu ---------- */
function renderStatus() {
  const statusEl = $('status');
  const projEl = $('status-project');
  const stopBtn = $('stop-btn');
  const noteInput = $('note-input');

  if (running) {
    statusEl.classList.add('status-running');
    projEl.textContent = running.project_name;
    projEl.style.color = running.project_color;
    $('status-since').textContent = `od ${fmtClock(running.started_at)}`;
    stopBtn.disabled = false;
    $('note-save').disabled = false;
    noteInput.placeholder = 'Pridať / zmeniť poznámku…';
  } else {
    statusEl.classList.remove('status-running');
    projEl.textContent = 'Nič nebeží';
    projEl.style.color = '';
    $('status-since').textContent = '';
    stopBtn.disabled = true;
    $('note-save').disabled = true;
    noteInput.placeholder = 'Poznámka — napíš a klikni na projekt…';
  }
}

function tick() {
  // Len minúty (pod hodinu „42m", nad hodinu „1h 7m").
  $('status-timer').textContent = running ? fmtShort(now() - running.started_at) : '';
}

/* ---------- Projekty ---------- */
function renderProjects() {
  const grid = $('projects');
  grid.innerHTML = '';
  if (projects.length === 0) {
    grid.innerHTML = '<div class="empty">Zatiaľ žiadne projekty. Pridaj prvý vyššie ↑</div>';
    return;
  }
  projects.forEach((p, i) => {
    const btn = document.createElement('button');
    btn.className = 'project-btn';
    if (running && running.project_id === p.id) btn.classList.add('active');
    const total = todayTotals[p.id] || 0;
    btn.innerHTML = `
      ${i < 9 ? `<span class="idx">${i + 1}</span>` : ''}
      <span class="prow">
        <span class="dot" style="background:${p.color}"></span>
        <span class="pname">${escapeHtml(p.name)}</span>
        <span class="gear" title="Upraviť">${GEAR_SVG}</span>
      </span>
      <span class="today-total">${total ? 'dnes ' + fmtShort(total) : ''}</span>`;
    btn.addEventListener('click', (e) => {
      // closest() — kliknutie môže trafiť SVG vnútri ikonky
      if (e.target.closest('.gear')) {
        editProject(btn, p);
        return;
      }
      switchTo(p.id);
    });
    grid.appendChild(btn);
  });
}

// Inline editácia projektu: názov, farba, zmazanie.
// Riadok projektu je <button>, takže formulár ho na čas úpravy nahradí.
function editProject(btn, p) {
  const form = document.createElement('form');
  form.className = 'project-edit';

  const color = document.createElement('input');
  color.type = 'color';
  color.className = 'p-color';
  color.value = p.color;
  color.title = 'Farba projektu';

  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'p-name';
  name.value = p.name;
  name.placeholder = 'Názov projektu…';

  const ok = document.createElement('button');
  ok.type = 'submit';
  ok.className = 'e-ok';
  ok.title = 'Uložiť';
  ok.textContent = '✓';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'e-cancel';
  cancel.title = 'Zrušiť';
  cancel.textContent = '✕';

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'p-del';
  del.textContent = 'Zmazať projekt';

  // Prepojenie na Kimai: výber projektu a aktivity (len ak je Kimai nakonfigurované).
  let kimaiProjSel = null;
  let kimaiActSel = null;
  let kimaiRow = null;
  if (kimaiEnabled) {
    kimaiRow = document.createElement('div');
    kimaiRow.className = 'p-kimai';
    kimaiProjSel = document.createElement('select');
    kimaiActSel = document.createElement('select');
    kimaiProjSel.innerHTML = '<option value="">Kimai: neprepojené</option>';
    kimaiActSel.innerHTML = '<option value="">— aktivita —</option>';
    kimaiActSel.disabled = true;
    kimaiRow.append(kimaiProjSel, kimaiActSel);

    const loadActivities = async (projectId, selectedId) => {
      kimaiActSel.innerHTML = '<option value="">— aktivita —</option>';
      kimaiActSel.disabled = !projectId;
      if (!projectId) return;
      try {
        const acts = await api.get(`/api/kimai/activities?project=${projectId}`);
        for (const a of acts) {
          const o = document.createElement('option');
          o.value = a.id;
          o.textContent = a.name;
          kimaiActSel.appendChild(o);
        }
        if (selectedId) kimaiActSel.value = String(selectedId);
      } catch {
        toast('Kimai: nepodarilo sa načítať aktivity');
      }
    };

    (async () => {
      try {
        kimaiProjects ??= await api.get('/api/kimai/projects');
        for (const kp of kimaiProjects) {
          const o = document.createElement('option');
          o.value = kp.id;
          o.textContent = kp.name;
          kimaiProjSel.appendChild(o);
        }
        if (p.kimai_project_id) {
          kimaiProjSel.value = String(p.kimai_project_id);
          await loadActivities(p.kimai_project_id, p.kimai_activity_id);
        }
      } catch {
        toast('Kimai: nepodarilo sa načítať projekty');
      }
    })();

    kimaiProjSel.addEventListener('change', () => loadActivities(kimaiProjSel.value, null));
  }

  form.append(color, name, ok, cancel);
  if (kimaiRow) form.append(kimaiRow);
  form.append(del);
  btn.replaceWith(form);
  name.focus();

  const close = () => renderProjects();
  cancel.addEventListener('click', close);
  form.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') close();
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const trimmed = name.value.trim();
    if (!trimmed) {
      toast('Názov nemôže byť prázdny');
      return;
    }
    const patch = { name: trimmed, color: color.value };
    if (kimaiEnabled) {
      patch.kimai_project_id = kimaiProjSel.value ? Number(kimaiProjSel.value) : null;
      patch.kimai_activity_id = kimaiActSel.value ? Number(kimaiActSel.value) : null;
    }
    try {
      await api.patch(`/api/projects/${p.id}`, patch);
      toast('Uložené');
    } catch (err) {
      if (err.message !== 'unauth') toast('Chyba: ' + err.message);
      return;
    }
    await refreshAll();
  });
  del.addEventListener('click', async () => {
    if (!confirm(`Zmazať projekt „${p.name}" a všetky jeho záznamy?`)) return;
    await api.del(`/api/projects/${p.id}`);
    if (running && running.project_id === p.id) running = null;
    toast('Projekt zmazaný');
    await refreshAll();
  });
}

/* ---------- Prepínanie ---------- */
async function switchTo(projectId, { focusNote = true } = {}) {
  const note = $('note-input').value.trim();
  try {
    const data = await api.post('/api/switch', { projectId, note });
    running = data.running;
    $('note-input').value = '';
    const p = projects.find((x) => x.id === projectId);
    toast(data.kimaiError ? '⚠ Kimai sync zlyhal' : `▶ ${p ? p.name : 'Projekt'}`);
    await refreshAll();
    // Po kliknutí myšou vráť fokus do poznámky (tok „napíš → klik").
    // Po klávesovej skratke fokus nechaj mimo, aby fungovali ďalšie skratky (napr. S = stop).
    if (focusNote) $('note-input').focus();
  } catch (e) {
    if (e.message !== 'unauth') toast('Chyba: ' + e.message);
  }
}

async function stopTracking() {
  if (!running) return;
  const r = await api.post('/api/stop');
  running = null;
  toast(r.kimaiError ? '⚠ Kimai sync zlyhal' : '■ Zastavené');
  await refreshAll();
}

/* ---------- Uloženie poznámky k bežiacemu záznamu ---------- */
async function saveNote() {
  if (!running) return;
  const note = $('note-input').value.trim();
  running.note = note;
  await api.patch(`/api/entries/${running.id}`, { note });
  $('note-input').value = '';
  renderStatus();
  toast('Poznámka uložená');
  await loadHistory();
}

/* ---------- História ---------- */
// Popis dňa: „Dnes (4. 7.)" / „Včera (3. 7.)" / „štvrtok (2. 7.)"
function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86400000);
  const dateStr = d.toLocaleDateString('sk-SK', { day: 'numeric', month: 'numeric' });
  if (diffDays === 0) return `Dnes (${dateStr})`;
  if (diffDays === 1) return `Včera (${dateStr})`;
  const weekday = d.toLocaleDateString('sk-SK', { weekday: 'long' });
  return `${weekday} (${dateStr})`;
}

async function loadHistory() {
  const data = await api.get(`/api/entries?${rangeQuery(historyRange)}`);
  const el = $('history');
  el.innerHTML = '';
  if (data.length === 0) {
    el.innerHTML = '<div class="empty">Žiadne záznamy.</div>';
    return;
  }

  // Zoskupenie po dňoch (dáta sú zoradené od najnovších) + súčet za deň.
  const groups = [];
  for (const e of data) {
    const key = new Date(e.started_at).toDateString();
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      g = { key, ts: e.started_at, entries: [], total: 0 };
      groups.push(g);
    }
    g.entries.push(e);
    g.total += (e.ended_at || now()) - e.started_at;
  }

  for (const g of groups) {
    const head = document.createElement('div');
    head.className = 'day-head';
    head.innerHTML = `
      <span class="day-label">${dayLabel(g.ts)}</span>
      <span class="day-total">${fmtShort(g.total)}</span>`;
    el.appendChild(head);
    for (const e of g.entries) renderHistoryRow(el, e);
  }
}

function renderHistoryRow(el, e) {
  {
    const row = document.createElement('div');
    row.className = 'history-row';
    const dur = (e.ended_at || now()) - e.started_at;
    row.innerHTML = `
      <span class="swatch" style="background:${e.project_color}"></span>
      <div class="hmain">
        <div class="hproj">${escapeHtml(e.project_name)}</div>
        ${e.note ? `<div class="hnote">${escapeHtml(e.note)}</div>` : ''}
      </div>
      <div class="hright">
        <div class="htime">${fmtClock(e.started_at)}–${e.ended_at ? fmtClock(e.ended_at) : '…'}</div>
        ${e.ended_at ? `<div class="hdur">${fmtShort(dur)}</div>` : `<div class="running-badge">beží</div>`}
      </div>
      <div class="hacts">
        <button class="hedit" title="Upraviť">${GEAR_SVG}</button>
      </div>`;
    row.querySelector('.hedit').addEventListener('click', () => editEntry(row, e));
    el.appendChild(row);
  }
}

// Inline editácia záznamu v histórii: poznámka + čas od/do.
// Pri bežiacom zázname sa dá meniť len začiatok.
const toHM = (ts) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
// Nový timestamp: pôvodný dátum záznamu + zadané HH:MM.
const withHM = (ts, hm) => {
  const [h, m] = hm.split(':').map(Number);
  const d = new Date(ts);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

function editEntry(row, entry) {
  if (row.classList.contains('editing')) return;
  row.classList.add('editing');

  const form = document.createElement('form');
  form.className = 'edit-form';

  const note = document.createElement('input');
  note.type = 'text';
  note.className = 'e-note';
  note.placeholder = 'Poznámka…';
  note.value = entry.note || '';

  const start = document.createElement('input');
  start.type = 'time';
  start.className = 'e-time';
  start.required = true;
  start.value = toHM(entry.started_at);

  let end = null;
  if (entry.ended_at) {
    end = document.createElement('input');
    end.type = 'time';
    end.className = 'e-time';
    end.required = true;
    end.value = toHM(entry.ended_at);
  }

  const ok = document.createElement('button');
  ok.type = 'submit';
  ok.className = 'e-ok';
  ok.title = 'Uložiť';
  ok.textContent = '✓';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'e-cancel';
  cancel.title = 'Zrušiť';
  cancel.textContent = '✕';

  const times = document.createElement('div');
  times.className = 'e-times';
  times.append(start);
  if (end) {
    const sep = document.createElement('span');
    sep.className = 'e-sep';
    sep.textContent = '–';
    times.append(sep, end);
  } else {
    const badge = document.createElement('span');
    badge.className = 'e-sep';
    badge.textContent = '– beží';
    times.append(badge);
  }
  times.append(ok, cancel);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'e-del';
  del.textContent = 'Zmazať záznam';

  form.append(note, times, del);
  row.appendChild(form);
  note.focus();

  del.addEventListener('click', async () => {
    if (!confirm('Zmazať tento záznam?')) return;
    await api.del(`/api/entries/${entry.id}`);
    if (running && running.id === entry.id) running = null;
    toast('Zmazané');
    await refreshAll();
  });

  const close = () => {
    form.remove();
    row.classList.remove('editing');
  };
  cancel.addEventListener('click', close);
  form.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') close();
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const patch = {
      note: note.value.trim(),
      started_at: withHM(entry.started_at, start.value),
    };
    if (end) {
      patch.ended_at = withHM(entry.ended_at, end.value);
      if (patch.ended_at <= patch.started_at) {
        toast('Koniec musí byť po začiatku');
        return;
      }
    } else if (patch.started_at > Date.now()) {
      toast('Začiatok nemôže byť v budúcnosti');
      return;
    }
    try {
      await api.patch(`/api/entries/${entry.id}`, patch);
      if (running && running.id === entry.id) {
        running.note = patch.note;
        running.started_at = patch.started_at;
      }
      toast('Uložené');
    } catch (err) {
      if (err.message !== 'unauth') toast('Chyba: ' + err.message);
      return;
    }
    await refreshAll();
  });
}

/* ---------- Obnovenie ---------- */
async function loadTodayTotals() {
  const data = await api.get(`/api/summary?${rangeQuery('today')}`);
  todayTotals = {};
  for (const d of data) todayTotals[d.project_id] = d.ms;
}

async function loadState() {
  const data = await api.get('/api/state');
  serverSkew = data.now - Date.now();
  running = data.running;
}

async function refreshAll() {
  await Promise.all([loadState(), loadProjects(), loadTodayTotals()]);
  renderStatus();
  renderProjects();
  tick();
  await loadHistory();
}

async function loadProjects() {
  projects = await api.get('/api/projects');
}

/* ---------- Utily ---------- */
function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

/* ---------- Fatálna chyba (namiesto prázdnej stránky) ---------- */
function showFatal(err) {
  console.error(err);
  const el = $('fatal');
  el.querySelector('.fatal-msg').textContent = err?.message || String(err);
  el.classList.remove('hidden');
  $('app').classList.add('hidden');
  $('login').classList.add('hidden');
}

/* ---------- Login ---------- */
function showLogin() {
  $('login').classList.remove('hidden');
  $('app').classList.add('hidden');
  $('login-password').focus();
}
function hideLogin() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
}

/* ---------- Klávesové skratky ---------- */
function onKey(e) {
  const typing =
    document.activeElement &&
    ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if (typing) return;
  if (e.key >= '1' && e.key <= '9') {
    const idx = Number(e.key) - 1;
    if (projects[idx]) {
      e.preventDefault();
      switchTo(projects[idx].id, { focusNote: false });
    }
  } else if (e.key.toLowerCase() === 's') {
    e.preventDefault();
    stopTracking();
  }
}

/* ---------- Inicializácia ---------- */
async function init() {
  // Prihlásenie
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.post('/api/login', { password: $('login-password').value });
      $('login-error').textContent = '';
      hideLogin();
      await boot();
    } catch (err) {
      $('login-error').textContent = err.message;
    }
  });

  const auth = await api.get('/api/auth');
  if (auth.required && !auth.authed) {
    showLogin();
    return;
  }
  hideLogin();
  await boot();
}

// Spustí appku po overení prístupu — beží práve raz.
let booted = false;
async function boot() {
  if (booted) return;
  booted = true;

  try {
    kimaiEnabled = (await api.get('/api/kimai/status')).enabled;
  } catch {
    kimaiEnabled = false;
  }

  // Ovládacie prvky
  $('stop-btn').addEventListener('click', stopTracking);
  $('note-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveNote().catch((err) => {
      if (err.message !== 'unauth') toast('Chyba: ' + err.message);
    });
  });

  $('new-project-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('new-project-name').value.trim();
    if (!name) return;
    await api.post('/api/projects', {
      name,
      color: $('new-project-color').value,
    });
    $('new-project-name').value = '';
    await refreshAll();
  });

  $('history-range').addEventListener('click', (e) => {
    // closest() namiesto e.target — na iOS Safari môže ťuknutie trafiť
    // okraj/medzeru prepínača a target potom nie je samotné tlačidlo.
    const btn = e.target.closest('button[data-range]');
    if (!btn) return;
    historyRange = btn.dataset.range;
    [...$('history-range').children].forEach((b) =>
      b.classList.toggle('active', b === btn)
    );
    loadHistory();
  });

  document.addEventListener('keydown', onKey);

  await refreshAll();
  setInterval(tick, 1000);
  // Priebežné obnovenie prehľadu času behom behu
  setInterval(() => {
    if (running) {
      loadTodayTotals().then(renderProjects);
    }
  }, 60000);
}

init().catch(showFatal);
