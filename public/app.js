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

const $ = (id) => document.getElementById(id);
const now = () => Date.now() + serverSkew;

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
        <span class="gear" title="Upraviť">⚙</span>
      </span>
      <span class="today-total">${total ? 'dnes ' + fmtShort(total) : ''}</span>`;
    btn.addEventListener('click', (e) => {
      if (e.target.classList.contains('gear')) {
        editProject(p);
        return;
      }
      switchTo(p.id);
    });
    grid.appendChild(btn);
  });
}

async function editProject(p) {
  const name = prompt('Názov projektu:', p.name);
  if (name === null) return;
  const trimmed = name.trim();
  if (trimmed === '' ) {
    if (confirm(`Zmazať projekt „${p.name}" a všetky jeho záznamy?`)) {
      await api.del(`/api/projects/${p.id}`);
      toast('Projekt zmazaný');
      await refreshAll();
    }
    return;
  }
  await api.patch(`/api/projects/${p.id}`, { name: trimmed });
  await refreshAll();
}

/* ---------- Prepínanie ---------- */
async function switchTo(projectId, { focusNote = true } = {}) {
  const note = $('note-input').value.trim();
  try {
    const data = await api.post('/api/switch', { projectId, note });
    running = data.running;
    $('note-input').value = '';
    const p = projects.find((x) => x.id === projectId);
    toast(`▶ ${p ? p.name : 'Projekt'}`);
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
  await api.post('/api/stop');
  running = null;
  toast('■ Zastavené');
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
async function loadHistory() {
  const data = await api.get(`/api/entries?${rangeQuery(historyRange)}`);
  const el = $('history');
  el.innerHTML = '';
  if (data.length === 0) {
    el.innerHTML = '<div class="empty">Žiadne záznamy.</div>';
    return;
  }
  for (const e of data) {
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
        <button class="hedit" title="Upraviť poznámku">✎</button>
        <button class="hdel" title="Zmazať">✕</button>
      </div>`;
    row.querySelector('.hedit').addEventListener('click', () => editEntryNote(row, e));
    row.querySelector('.hdel').addEventListener('click', async () => {
      await api.del(`/api/entries/${e.id}`);
      if (running && running.id === e.id) running = null;
      await refreshAll();
    });
    el.appendChild(row);
  }
}

// Inline editácia poznámky priamo v riadku histórie — funguje aj pre ukončené záznamy.
function editEntryNote(row, entry) {
  if (row.querySelector('.hnote-input')) return;
  const main = row.querySelector('.hmain');
  main.querySelector('.hnote')?.remove();
  const input = document.createElement('input');
  input.className = 'hnote-input';
  input.type = 'text';
  input.value = entry.note || '';
  input.placeholder = 'Poznámka…';
  main.appendChild(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    if (save) {
      const note = input.value.trim();
      try {
        await api.patch(`/api/entries/${entry.id}`, { note });
        if (running && running.id === entry.id) running.note = note;
        toast('Poznámka uložená');
      } catch (err) {
        if (err.message !== 'unauth') toast('Chyba: ' + err.message);
      }
    }
    await refreshAll();
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') finish(true);
    else if (ev.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
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
      await refreshAll();
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
