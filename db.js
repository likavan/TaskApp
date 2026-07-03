import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, 'data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const db = new Database(join(dataDir, 'taskapp.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '#4f8cff',
    archived   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    note       TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL,
    ended_at   INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_entries_started ON entries(started_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_running
    ON entries(ended_at) WHERE ended_at IS NULL;
`);

const now = () => Date.now();

/* ---------- Projects ---------- */

export function listProjects({ includeArchived = false } = {}) {
  // Zoradené podľa naposledy použitého (posledný started_at), potom podľa mena.
  const sql = `
    SELECT p.*, MAX(e.started_at) AS last_used
    FROM projects p
    LEFT JOIN entries e ON e.project_id = p.id
    ${includeArchived ? '' : 'WHERE p.archived = 0'}
    GROUP BY p.id
    ORDER BY (last_used IS NULL), last_used DESC, p.name COLLATE NOCASE ASC
  `;
  return db.prepare(sql).all();
}

export function getProject(id) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

export function createProject({ name, color }) {
  const info = db
    .prepare('INSERT INTO projects (name, color, created_at) VALUES (?, ?, ?)')
    .run(name.trim(), color || '#4f8cff', now());
  return getProject(info.lastInsertRowid);
}

export function updateProject(id, fields) {
  const allowed = ['name', 'color', 'archived'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (keys.length === 0) return getProject(id);
  const setClause = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE projects SET ${setClause} WHERE id = @id`).run({ id, ...fields });
  return getProject(id);
}

export function deleteProject(id) {
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

/* ---------- Entries / state ---------- */

export function getRunning() {
  return db
    .prepare(
      `SELECT e.*, p.name AS project_name, p.color AS project_color
       FROM entries e JOIN projects p ON p.id = e.project_id
       WHERE e.ended_at IS NULL`
    )
    .get();
}

function stopRunningTx(ts) {
  db.prepare('UPDATE entries SET ended_at = ? WHERE ended_at IS NULL').run(ts);
}

// Zastaví bežiaci záznam a spustí nový pre daný projekt — atomicky.
export const switchProject = db.transaction(({ projectId, note = '' }) => {
  const project = getProject(projectId);
  if (!project) throw new Error('Projekt neexistuje');
  const ts = now();
  stopRunningTx(ts);
  const info = db
    .prepare(
      'INSERT INTO entries (project_id, note, started_at, created_at) VALUES (?, ?, ?, ?)'
    )
    .run(projectId, note, ts, ts);
  return db.prepare('SELECT * FROM entries WHERE id = ?').get(info.lastInsertRowid);
});

export function stopRunning() {
  const running = getRunning();
  if (!running) return null;
  stopRunningTx(now());
  return db.prepare('SELECT * FROM entries WHERE id = ?').get(running.id);
}

export function updateEntry(id, fields) {
  const allowed = ['note', 'started_at', 'ended_at', 'project_id'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (keys.length === 0) return db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
  const setClause = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE entries SET ${setClause} WHERE id = @id`).run({ id, ...fields });
  return db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
}

export function deleteEntry(id) {
  db.prepare('DELETE FROM entries WHERE id = ?').run(id);
}

export function listEntries({ from, to, limit = 200 }) {
  return db
    .prepare(
      `SELECT e.*, p.name AS project_name, p.color AS project_color
       FROM entries e JOIN projects p ON p.id = e.project_id
       WHERE e.started_at >= ? AND e.started_at < ?
       ORDER BY e.started_at DESC
       LIMIT ?`
    )
    .all(from, to, limit);
}

// Súčet trvania na projekt v danom rozsahu (v milisekundách).
// Bežiaci záznam sa počíta po aktuálny čas.
export function summary({ from, to }) {
  const ts = now();
  return db
    .prepare(
      `SELECT p.id AS project_id, p.name AS project_name, p.color AS project_color,
              SUM(MIN(COALESCE(e.ended_at, @ts), @to) - MAX(e.started_at, @from)) AS ms
       FROM entries e JOIN projects p ON p.id = e.project_id
       WHERE e.started_at < @to AND COALESCE(e.ended_at, @ts) > @from
       GROUP BY p.id
       HAVING ms > 0
       ORDER BY ms DESC`
    )
    .all({ from, to, ts });
}

export default db;
