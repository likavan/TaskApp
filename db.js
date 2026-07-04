import { createClient } from '@libsql/client';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Lokálne: SQLite súbor v data/. Na Verceli/produkcii: Turso cez TURSO_DATABASE_URL.
// Klient vytvárame lenivo, aby chýbajúca konfigurácia nezhodila celý modul pri importe
// (na Verceli je disk read-only a mkdir by spadol) — chyba sa tak vráti ako čitateľná
// JSON odpoveď z API namiesto pádu funkcie.
let client = null;
function getClient() {
  if (client) return client;
  if (!process.env.TURSO_DATABASE_URL && process.env.VERCEL) {
    throw new Error(
      'Databáza nie je nakonfigurovaná. Vo Vercel projekte nastav TURSO_DATABASE_URL ' +
        'a TURSO_AUTH_TOKEN (Settings → Environment Variables) a sprav redeploy.'
    );
  }
  const url =
    process.env.TURSO_DATABASE_URL || 'file:' + join(__dirname, 'data', 'taskapp.db');
  if (url.startsWith('file:')) {
    const dataDir = join(__dirname, 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  }
  client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  return client;
}

let initPromise = null;
function init() {
  // Pri zlyhaní inicializáciu nememoizujeme, aby sa ďalší pokus mohol podariť
  // (napr. krátkodobý výpadok siete smerom k Turso).
  initPromise ??= getClient()
    .batch(
      [
      `CREATE TABLE IF NOT EXISTS projects (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        color      TEXT NOT NULL DEFAULT '#4f8cff',
        archived   INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS entries (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        note       TEXT NOT NULL DEFAULT '',
        started_at INTEGER NOT NULL,
        ended_at   INTEGER,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_entries_started ON entries(started_at)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_running
        ON entries(ended_at) WHERE ended_at IS NULL`,
      ],
      'write'
    )
    .then(async () => {
      // Migrácie: nové stĺpce pre prepojenie s Kimai (ignoruj "už existuje").
      const alters = [
        'ALTER TABLE projects ADD COLUMN kimai_project_id INTEGER',
        'ALTER TABLE projects ADD COLUMN kimai_activity_id INTEGER',
        'ALTER TABLE projects ADD COLUMN kimai_customer_id INTEGER',
        'ALTER TABLE entries ADD COLUMN kimai_id INTEGER',
      ];
      for (const sql of alters) {
        try {
          await getClient().execute(sql);
        } catch {
          /* stĺpec už existuje */
        }
      }
    })
    .catch((e) => {
      initPromise = null;
      throw e;
    });
  return initPromise;
}

const now = () => Date.now();
const rowId = (res) => Number(res.lastInsertRowid);

async function all(sql, args = {}) {
  await init();
  const res = await getClient().execute({ sql, args });
  return res.rows;
}

async function get(sql, args = {}) {
  return (await all(sql, args))[0];
}

async function run(sql, args = {}) {
  await init();
  return getClient().execute({ sql, args });
}

/* ---------- Projects ---------- */

export function listProjects({ includeArchived = false } = {}) {
  // Zoradené podľa naposledy použitého (posledný started_at), potom podľa mena.
  return all(`
    SELECT p.*, MAX(e.started_at) AS last_used
    FROM projects p
    LEFT JOIN entries e ON e.project_id = p.id
    ${includeArchived ? '' : 'WHERE p.archived = 0'}
    GROUP BY p.id
    ORDER BY (last_used IS NULL), last_used DESC, p.name COLLATE NOCASE ASC
  `);
}

export function getProject(id) {
  return get('SELECT * FROM projects WHERE id = @id', { id });
}

export async function createProject({ name, color }) {
  const res = await run(
    'INSERT INTO projects (name, color, created_at) VALUES (@name, @color, @ts)',
    { name: name.trim(), color: color || '#4f8cff', ts: now() }
  );
  return getProject(rowId(res));
}

export async function updateProject(id, fields) {
  const allowed = [
    'name',
    'color',
    'archived',
    'kimai_customer_id',
    'kimai_project_id',
    'kimai_activity_id',
  ];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (keys.length === 0) return getProject(id);
  const setClause = keys.map((k) => `${k} = @${k}`).join(', ');
  const args = { id };
  for (const k of keys) args[k] = fields[k];
  await run(`UPDATE projects SET ${setClause} WHERE id = @id`, args);
  return getProject(id);
}

export async function deleteProject(id) {
  await init();
  // Záznamy mažeme explicitne — FK pragma nemusí byť na remote spojení zapnutá.
  await getClient().batch(
    [
      { sql: 'DELETE FROM entries WHERE project_id = @id', args: { id } },
      { sql: 'DELETE FROM projects WHERE id = @id', args: { id } },
    ],
    'write'
  );
}

/* ---------- Entries / state ---------- */

export function getRunning() {
  return get(
    `SELECT e.*, p.name AS project_name, p.color AS project_color
     FROM entries e JOIN projects p ON p.id = e.project_id
     WHERE e.ended_at IS NULL`
  );
}

export function getEntry(id) {
  return get('SELECT * FROM entries WHERE id = @id', { id });
}

// Zastaví bežiaci záznam a spustí nový pre daný projekt — atomicky (batch = transakcia).
export async function switchProject({ projectId, note = '' }) {
  const project = await getProject(projectId);
  if (!project) throw new Error('Projekt neexistuje');
  const ts = now();
  await init();
  const results = await getClient().batch(
    [
      { sql: 'UPDATE entries SET ended_at = @ts WHERE ended_at IS NULL', args: { ts } },
      {
        sql: `INSERT INTO entries (project_id, note, started_at, created_at)
              VALUES (@projectId, @note, @ts, @ts)`,
        args: { projectId, note, ts },
      },
    ],
    'write'
  );
  return getEntry(rowId(results[1]));
}

export async function stopRunning() {
  const running = await getRunning();
  if (!running) return null;
  await run('UPDATE entries SET ended_at = @ts WHERE ended_at IS NULL', { ts: now() });
  return getEntry(running.id);
}

export async function updateEntry(id, fields) {
  const allowed = ['note', 'started_at', 'ended_at', 'project_id', 'kimai_id'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (keys.length === 0) return getEntry(id);
  const setClause = keys.map((k) => `${k} = @${k}`).join(', ');
  const args = { id };
  for (const k of keys) args[k] = fields[k];
  await run(`UPDATE entries SET ${setClause} WHERE id = @id`, args);
  return getEntry(id);
}

export function deleteEntry(id) {
  return run('DELETE FROM entries WHERE id = @id', { id });
}

export function listEntries({ from, to, limit = 200 }) {
  return all(
    `SELECT e.*, p.name AS project_name, p.color AS project_color
     FROM entries e JOIN projects p ON p.id = e.project_id
     WHERE e.started_at >= @from AND e.started_at < @to
     ORDER BY e.started_at DESC
     LIMIT @limit`,
    { from, to, limit }
  );
}

// Súčet trvania na projekt v danom rozsahu (v milisekundách).
// Bežiaci záznam sa počíta po aktuálny čas.
export function summary({ from, to }) {
  return all(
    `SELECT p.id AS project_id, p.name AS project_name, p.color AS project_color,
            SUM(MIN(COALESCE(e.ended_at, @ts), @to) - MAX(e.started_at, @from)) AS ms
     FROM entries e JOIN projects p ON p.id = e.project_id
     WHERE e.started_at < @to AND COALESCE(e.ended_at, @ts) > @from
     GROUP BY p.id
     HAVING ms > 0
     ORDER BY ms DESC`,
    { from, to, ts: now() }
  );
}
