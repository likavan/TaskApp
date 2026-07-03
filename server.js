import express from 'express';
import crypto from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

/* ---------- Voliteľná jednoduchá ochrana heslom ---------- */
const PASSWORD = process.env.APP_PASSWORD;
const TOKEN = PASSWORD
  ? crypto.createHash('sha256').update(PASSWORD).digest('hex')
  : null;
const COOKIE = 'taskapp_auth';

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function isAuthed(req) {
  if (!TOKEN) return true;
  const token = parseCookies(req)[COOKIE];
  if (!token || token.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(TOKEN));
}

app.post('/api/login', (req, res) => {
  if (!TOKEN) return res.json({ ok: true });
  const given = crypto
    .createHash('sha256')
    .update(String(req.body?.password ?? ''))
    .digest('hex');
  if (crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN))) {
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 90}`
    );
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Nesprávne heslo' });
});

app.get('/api/auth', (req, res) => {
  res.json({ required: !!TOKEN, authed: isAuthed(req) });
});

// Chráň API (okrem prihlásenia a stavu auth).
app.use('/api', (req, res, next) => {
  if (req.path === '/login' || req.path === '/auth') return next();
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'Vyžaduje sa prihlásenie' });
});

/* ---------- Pomocník: časové rozsahy ---------- */
function rangeBounds(range) {
  const d = new Date();
  const to = Date.now();
  if (range === 'week') {
    const day = (d.getDay() + 6) % 7; // pondelok = 0
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
    return { from: start.getTime(), to };
  }
  // predvolene "today"
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return { from: start.getTime(), to };
}

/* ---------- Projekty ---------- */
app.get('/api/projects', (req, res) => {
  res.json(db.listProjects({ includeArchived: req.query.all === '1' }));
});

app.post('/api/projects', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'Názov je povinný' });
  res.status(201).json(db.createProject({ name, color: req.body?.color }));
});

app.patch('/api/projects/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.getProject(id)) return res.status(404).json({ error: 'Nenájdené' });
  res.json(db.updateProject(id, req.body ?? {}));
});

app.delete('/api/projects/:id', (req, res) => {
  db.deleteProject(Number(req.params.id));
  res.json({ ok: true });
});

/* ---------- Stav / prepínanie ---------- */
app.get('/api/state', (req, res) => {
  res.json({ running: db.getRunning() ?? null, now: Date.now() });
});

app.post('/api/switch', (req, res) => {
  const projectId = Number(req.body?.projectId);
  if (!db.getProject(projectId))
    return res.status(400).json({ error: 'Neplatný projekt' });
  const entry = db.switchProject({ projectId, note: String(req.body?.note ?? '') });
  res.json({ running: db.getRunning(), entry });
});

app.post('/api/stop', (req, res) => {
  res.json({ stopped: db.stopRunning() });
});

/* ---------- Záznamy ---------- */
app.patch('/api/entries/:id', (req, res) => {
  res.json(db.updateEntry(Number(req.params.id), req.body ?? {}));
});

app.delete('/api/entries/:id', (req, res) => {
  db.deleteEntry(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/entries', (req, res) => {
  const { from, to } = rangeBounds(req.query.range);
  res.json(db.listEntries({ from, to }));
});

app.get('/api/summary', (req, res) => {
  const { from, to } = rangeBounds(req.query.range);
  res.json(db.summary({ from, to }));
});

/* ---------- Statické súbory ---------- */
app.use(express.static(join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`TaskApp beží na http://localhost:${PORT}`);
  if (TOKEN) console.log('Ochrana heslom je zapnutá (APP_PASSWORD).');
});
