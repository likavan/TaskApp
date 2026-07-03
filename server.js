import express from 'express';
import crypto from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Express 4 nechytá chyby z async handlerov — malý wrapper.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
app.get(
  '/api/projects',
  ah(async (req, res) => {
    res.json(await db.listProjects({ includeArchived: req.query.all === '1' }));
  })
);

app.post(
  '/api/projects',
  ah(async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'Názov je povinný' });
    res.status(201).json(await db.createProject({ name, color: req.body?.color }));
  })
);

app.patch(
  '/api/projects/:id',
  ah(async (req, res) => {
    const id = Number(req.params.id);
    if (!(await db.getProject(id))) return res.status(404).json({ error: 'Nenájdené' });
    res.json(await db.updateProject(id, req.body ?? {}));
  })
);

app.delete(
  '/api/projects/:id',
  ah(async (req, res) => {
    await db.deleteProject(Number(req.params.id));
    res.json({ ok: true });
  })
);

/* ---------- Stav / prepínanie ---------- */
app.get(
  '/api/state',
  ah(async (req, res) => {
    res.json({ running: (await db.getRunning()) ?? null, now: Date.now() });
  })
);

app.post(
  '/api/switch',
  ah(async (req, res) => {
    const projectId = Number(req.body?.projectId);
    if (!(await db.getProject(projectId)))
      return res.status(400).json({ error: 'Neplatný projekt' });
    const entry = await db.switchProject({
      projectId,
      note: String(req.body?.note ?? ''),
    });
    res.json({ running: await db.getRunning(), entry });
  })
);

app.post(
  '/api/stop',
  ah(async (req, res) => {
    res.json({ stopped: await db.stopRunning() });
  })
);

/* ---------- Záznamy ---------- */
app.patch(
  '/api/entries/:id',
  ah(async (req, res) => {
    res.json(await db.updateEntry(Number(req.params.id), req.body ?? {}));
  })
);

app.delete(
  '/api/entries/:id',
  ah(async (req, res) => {
    await db.deleteEntry(Number(req.params.id));
    res.json({ ok: true });
  })
);

app.get(
  '/api/entries',
  ah(async (req, res) => {
    const { from, to } = rangeBounds(req.query.range);
    res.json(await db.listEntries({ from, to }));
  })
);

app.get(
  '/api/summary',
  ah(async (req, res) => {
    const { from, to } = rangeBounds(req.query.range);
    res.json(await db.summary({ from, to }));
  })
);

/* ---------- Statické súbory (lokálny beh; na Verceli ich servíruje CDN) ---------- */
app.use(express.static(join(__dirname, 'public')));

/* ---------- Chybový handler ---------- */
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Interná chyba' });
});

// Na Verceli appku exportujeme ako serverless funkciu; lokálne počúvame na porte.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`TaskApp beží na http://localhost:${PORT}`);
    if (TOKEN) console.log('Ochrana heslom je zapnutá (APP_PASSWORD).');
  });
}

export default app;
