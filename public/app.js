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
let noteSaveTimer = null;

const $ = (id) => document.getElementById(id);
const now = () => Date.now() + serverSkew;

/* ---------- Formátovanie ---------- */
function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(
    sec
  ).padStart(2, '0')}`;
}
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
    if (document.activeElement !== noteInput) noteInput.value = running.note || '';
    noteInput.placeholder = 'Poznámka k bežiacemu záznamu…';
  } else {
    statusEl.classList.remove('status-running');
    projEl.textContent = 'Nič nebeží';
    projEl.style.color = '';
    $('status-since').textContent = '';
    stopBtn.disabled = true;
    noteInput.placeholder = 'Poznámka — napíš a klikni na projekt…';
  }
}

function tick() {
  const timerEl = $('status-timer');
  timerEl.textContent = running ? fmtDuration(now() - running.started_at) : '00:00:00';
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

/* ---------- Poznámka za behu ---------- */
function onNoteInput() {
  if (!running) return;
  clearTimeout(noteSaveTimer);
  noteSaveTimer = setTimeout(async () => {
    const note = $('note-input').value;
    running.note = note;
    await api.patch(`/api/entries/${running.id}`, { note });
  }, 500);
}

/* ---------- História ---------- */
async function loadHistory() {
  const data = await api.get(`/api/entries?range=${historyRange}`);
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
    const swatch = `<span class="swatch" style="background:${e.project_color}"></span>`;
    const time = `<span class="htime">${fmtClock(e.started_at)}–${
      e.ended_at ? fmtClock(e.ended_at) : '…'
    }</span>`;
    const note = `<span class="hnote"><span class="hproj">${escapeHtml(
      e.project_name
    )}</span>${e.note ? ' <span class="hmuted">· ' + escapeHtml(e.note) + '</span>' : ''}</span>`;
    const durEl = e.ended_at
      ? `<span class="hdur">${fmtShort(dur)}</span>`
      : `<span class="running-badge">beží</span>`;
    row.innerHTML = `${swatch}${time}${note}${durEl}<button class="hdel" title="Zmazať">✕</button>`;
    row.querySelector('.hdel').addEventListener('click', async () => {
      await api.del(`/api/entries/${e.id}`);
      if (running && running.id === e.id) running = null;
      await refreshAll();
    });
    el.appendChild(row);
  }
}

/* ---------- Obnovenie ---------- */
async function loadTodayTotals() {
  const data = await api.get('/api/summary?range=today');
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
  $('note-input').addEventListener('input', onNoteInput);
  $('note-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.target.blur();
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
    if (e.target.dataset.range) {
      historyRange = e.target.dataset.range;
      [...$('history-range').children].forEach((b) =>
        b.classList.toggle('active', b === e.target)
      );
      loadHistory();
    }
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
