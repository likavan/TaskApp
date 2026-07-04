<?php
/**
 * TaskApp API — PHP backend pre zdieľaný hosting (napr. Websupport).
 *
 * Identické endpointy a JSON tvary ako Node verzia (server.js), takže
 * frontend funguje bez zmeny. Dáta v SQLite súbore data/taskapp.db.
 * Konfigurácia v config.php (viď config.example.php).
 */

declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '0');

/* ---------- Konfigurácia ---------- */
$CONFIG = file_exists(__DIR__ . '/config.php') ? (require __DIR__ . '/config.php') : [];
function cfg(string $key, $default = null)
{
    global $CONFIG;
    $v = $CONFIG[$key] ?? $default;
    return ($v === '' ? $default : $v);
}

/* ---------- Pomocníci ---------- */
function json_out($data, int $code = 200): never
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(string $message, int $code = 500): never
{
    json_out(['error' => $message], $code);
}

function now_ms(): int
{
    return (int) round(microtime(true) * 1000);
}

$BODY = json_decode(file_get_contents('php://input'), true);
if (!is_array($BODY)) {
    $BODY = [];
}

set_exception_handler(function (Throwable $e) {
    error_log('TaskApp: ' . $e->getMessage());
    fail($e->getMessage(), 500);
});

/* ---------- Databáza (SQLite) ---------- */
$dataDir = __DIR__ . '/data';
if (!is_dir($dataDir)) {
    if (!mkdir($dataDir, 0775, true)) {
        fail('Nepodarilo sa vytvoriť priečinok data/ — skontroluj práva na zápis.');
    }
}
// Zamedz priamemu stiahnutiu databázy cez web.
if (!file_exists($dataDir . '/.htaccess')) {
    file_put_contents($dataDir . '/.htaccess', "Require all denied\n");
}

$db = new PDO('sqlite:' . $dataDir . '/taskapp.db');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->setAttribute(PDO::ATTR_STRINGIFY_FETCHES, false);
$db->exec('PRAGMA journal_mode = WAL');
$db->exec('PRAGMA foreign_keys = ON');
$db->exec('CREATE TABLE IF NOT EXISTS projects (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT \'#4f8cff\',
    archived   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
)');
$db->exec('CREATE TABLE IF NOT EXISTS entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    note       TEXT NOT NULL DEFAULT \'\',
    started_at INTEGER NOT NULL,
    ended_at   INTEGER,
    created_at INTEGER NOT NULL
)');
$db->exec('CREATE INDEX IF NOT EXISTS idx_entries_started ON entries(started_at)');
$db->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_running
    ON entries(ended_at) WHERE ended_at IS NULL');
// Migrácie (ignoruj "stĺpec už existuje")
foreach ([
    'ALTER TABLE projects ADD COLUMN kimai_project_id INTEGER',
    'ALTER TABLE projects ADD COLUMN kimai_activity_id INTEGER',
    'ALTER TABLE entries ADD COLUMN kimai_id INTEGER',
] as $sql) {
    try {
        $db->exec($sql);
    } catch (Throwable $e) {
        // stĺpec už existuje
    }
}

// PDO->execute() binduje všetko ako text; SQLite potom v MIN/MAX/aritmetike
// porovnáva text s číslom. Bindujeme preto explicitne podľa PHP typu.
function stmt(string $sql, array $args): PDOStatement
{
    global $db;
    $st = $db->prepare($sql);
    foreach ($args as $k => $v) {
        $type = match (true) {
            is_int($v) => PDO::PARAM_INT,
            is_bool($v) => PDO::PARAM_BOOL,
            is_null($v) => PDO::PARAM_NULL,
            default => PDO::PARAM_STR,
        };
        $st->bindValue(':' . $k, $v, $type);
    }
    $st->execute();
    return $st;
}

function q(string $sql, array $args = []): array
{
    return stmt($sql, $args)->fetchAll(PDO::FETCH_ASSOC);
}

function q1(string $sql, array $args = []): ?array
{
    $rows = q($sql, $args);
    return $rows[0] ?? null;
}

function run(string $sql, array $args = []): void
{
    stmt($sql, $args);
}

function get_project(int $id): ?array
{
    return q1('SELECT * FROM projects WHERE id = :id', ['id' => $id]);
}

function get_entry(int $id): ?array
{
    return q1('SELECT * FROM entries WHERE id = :id', ['id' => $id]);
}

function get_running(): ?array
{
    return q1('SELECT e.*, p.name AS project_name, p.color AS project_color
        FROM entries e JOIN projects p ON p.id = e.project_id
        WHERE e.ended_at IS NULL');
}

/* ---------- Kimai (živé zrkadlenie, best-effort) ---------- */
function kimai_enabled(): bool
{
    return (bool) (cfg('KIMAI_URL') && cfg('KIMAI_API_TOKEN'));
}

function kimai_fetch(string $path, string $method = 'GET', ?array $payload = null)
{
    $base = rtrim((string) cfg('KIMAI_URL'), '/');
    $ch = curl_init($base . $path);
    $headers = [
        'Authorization: Bearer ' . cfg('KIMAI_API_TOKEN'),
        'Content-Type: application/json',
    ];
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_TIMEOUT => 10,
    ]);
    if ($payload !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
    }
    $res = curl_exec($ch);
    if ($res === false) {
        $err = curl_error($ch);
        curl_close($ch);
        throw new RuntimeException('Kimai: ' . $err);
    }
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if ($status >= 400) {
        throw new RuntimeException('Kimai ' . $status . ': ' . substr($res, 0, 200));
    }
    return $res === '' ? null : json_decode($res, true);
}

function kimai_date(int $ms): string
{
    $tz = new DateTimeZone((string) cfg('KIMAI_TIMEZONE', 'Europe/Bratislava'));
    $d = (new DateTimeImmutable('@' . intdiv($ms, 1000)))->setTimezone($tz);
    return $d->format('Y-m-d\TH:i:s');
}

function kimai_stop_entry(?array $entry): void
{
    if (!kimai_enabled() || !$entry || empty($entry['kimai_id']) || empty($entry['ended_at'])) {
        return;
    }
    kimai_fetch('/api/timesheets/' . $entry['kimai_id'], 'PATCH', [
        'end' => kimai_date((int) $entry['ended_at']),
    ]);
}

function kimai_start_entry(array $entry, array $project): void
{
    if (!kimai_enabled() || empty($project['kimai_project_id']) || empty($project['kimai_activity_id'])) {
        return;
    }
    $ts = kimai_fetch('/api/timesheets', 'POST', [
        'begin' => kimai_date((int) $entry['started_at']),
        'project' => (int) $project['kimai_project_id'],
        'activity' => (int) $project['kimai_activity_id'],
        'description' => $entry['note'] ?? '',
    ]);
    if (isset($ts['id'])) {
        run('UPDATE entries SET kimai_id = :k WHERE id = :id', ['k' => $ts['id'], 'id' => $entry['id']]);
    }
}

/* ---------- Routing ---------- */
$uriPath = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?? '/';
$pos = strpos($uriPath, '/api/');
if ($pos === false) {
    fail('Nenájdené', 404);
}
$path = substr($uriPath, $pos + strlen('/api'));
$method = $_SERVER['REQUEST_METHOD'];

/* ---------- Autentifikácia ---------- */
$PASSWORD = cfg('APP_PASSWORD');
$TOKEN = $PASSWORD ? hash('sha256', (string) $PASSWORD) : null;
const COOKIE = 'taskapp_auth';

function is_authed(?string $token): bool
{
    if ($token === null) {
        return true;
    }
    $given = $_COOKIE[COOKIE] ?? '';
    return is_string($given) && hash_equals($token, $given);
}

if ($method === 'POST' && $path === '/login') {
    if ($TOKEN === null) {
        json_out(['ok' => true]);
    }
    $given = hash('sha256', (string) ($BODY['password'] ?? ''));
    if (hash_equals($TOKEN, $given)) {
        setcookie(COOKIE, $TOKEN, [
            'expires' => time() + 60 * 60 * 24 * 90,
            'path' => '/',
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
        json_out(['ok' => true]);
    }
    fail('Nesprávne heslo', 401);
}

if ($method === 'GET' && $path === '/auth') {
    json_out(['required' => $TOKEN !== null, 'authed' => is_authed($TOKEN)]);
}

if (!is_authed($TOKEN)) {
    fail('Vyžaduje sa prihlásenie', 401);
}

/* ---------- Časové rozsahy ---------- */
function range_bounds(): array
{
    $from = isset($_GET['from']) ? (int) $_GET['from'] : null;
    $to = isset($_GET['to']) ? (int) $_GET['to'] : null;
    if ($from !== null && $to !== null && $from < $to) {
        return [$from, $to];
    }
    // Fallback pre priame volania API bez from/to.
    $tz = new DateTimeZone((string) cfg('KIMAI_TIMEZONE', 'Europe/Bratislava'));
    $nowLocal = new DateTimeImmutable('now', $tz);
    $to = now_ms();
    if (($_GET['range'] ?? '') === 'week') {
        $start = $nowLocal->modify('monday this week')->setTime(0, 0);
    } else {
        $start = $nowLocal->setTime(0, 0);
    }
    return [$start->getTimestamp() * 1000, $to];
}

/* ---------- Kimai endpointy ---------- */
if ($method === 'GET' && $path === '/kimai/status') {
    json_out(['enabled' => kimai_enabled()]);
}
if ($method === 'GET' && $path === '/kimai/projects') {
    json_out(kimai_fetch('/api/projects'));
}
if ($method === 'GET' && $path === '/kimai/activities') {
    $p = isset($_GET['project']) ? '?project=' . (int) $_GET['project'] : '';
    json_out(kimai_fetch('/api/activities' . $p));
}

/* ---------- Projekty ---------- */
if ($method === 'GET' && $path === '/projects') {
    $where = ($_GET['all'] ?? '') === '1' ? '' : 'WHERE p.archived = 0';
    json_out(q("SELECT p.*, MAX(e.started_at) AS last_used
        FROM projects p LEFT JOIN entries e ON e.project_id = p.id
        $where
        GROUP BY p.id
        ORDER BY (last_used IS NULL), last_used DESC, p.name COLLATE NOCASE ASC"));
}

if ($method === 'POST' && $path === '/projects') {
    $name = trim((string) ($BODY['name'] ?? ''));
    if ($name === '') {
        fail('Názov je povinný', 400);
    }
    run('INSERT INTO projects (name, color, created_at) VALUES (:n, :c, :t)', [
        'n' => $name,
        'c' => (string) ($BODY['color'] ?? '#4f8cff'),
        't' => now_ms(),
    ]);
    json_out(get_project((int) $db->lastInsertId()), 201);
}

if (preg_match('#^/projects/(\d+)$#', $path, $m)) {
    $id = (int) $m[1];
    if ($method === 'PATCH') {
        if (!get_project($id)) {
            fail('Nenájdené', 404);
        }
        $allowed = ['name', 'color', 'archived', 'kimai_project_id', 'kimai_activity_id'];
        $sets = [];
        $args = ['id' => $id];
        foreach ($allowed as $k) {
            if (array_key_exists($k, $BODY)) {
                $sets[] = "$k = :$k";
                $args[$k] = $BODY[$k];
            }
        }
        if ($sets) {
            run('UPDATE projects SET ' . implode(', ', $sets) . ' WHERE id = :id', $args);
        }
        json_out(get_project($id));
    }
    if ($method === 'DELETE') {
        run('DELETE FROM entries WHERE project_id = :id', ['id' => $id]);
        run('DELETE FROM projects WHERE id = :id', ['id' => $id]);
        json_out(['ok' => true]);
    }
}

/* ---------- Stav / prepínanie ---------- */
if ($method === 'GET' && $path === '/state') {
    json_out(['running' => get_running(), 'now' => now_ms()]);
}

if ($method === 'POST' && $path === '/switch') {
    $projectId = (int) ($BODY['projectId'] ?? 0);
    $project = get_project($projectId);
    if (!$project) {
        fail('Neplatný projekt', 400);
    }
    $prev = get_running();
    $ts = now_ms();
    $db->beginTransaction();
    run('UPDATE entries SET ended_at = :t WHERE ended_at IS NULL', ['t' => $ts]);
    run('INSERT INTO entries (project_id, note, started_at, created_at) VALUES (:p, :n, :t, :t2)', [
        'p' => $projectId,
        'n' => (string) ($BODY['note'] ?? ''),
        't' => $ts,
        't2' => $ts,
    ]);
    $entryId = (int) $db->lastInsertId();
    $db->commit();
    $entry = get_entry($entryId);

    $kimaiError = null;
    try {
        if ($prev) {
            $prev['ended_at'] = $ts;
            kimai_stop_entry($prev);
        }
        kimai_start_entry($entry, $project);
    } catch (Throwable $e) {
        error_log('Kimai sync: ' . $e->getMessage());
        $kimaiError = $e->getMessage();
    }
    json_out(['running' => get_running(), 'entry' => get_entry($entryId), 'kimaiError' => $kimaiError]);
}

if ($method === 'POST' && $path === '/stop') {
    $running = get_running();
    $stopped = null;
    $kimaiError = null;
    if ($running) {
        run('UPDATE entries SET ended_at = :t WHERE ended_at IS NULL', ['t' => now_ms()]);
        $stopped = get_entry((int) $running['id']);
        try {
            kimai_stop_entry($stopped);
        } catch (Throwable $e) {
            error_log('Kimai sync: ' . $e->getMessage());
            $kimaiError = $e->getMessage();
        }
    }
    json_out(['stopped' => $stopped, 'kimaiError' => $kimaiError]);
}

/* ---------- Záznamy ---------- */
if ($method === 'GET' && $path === '/entries') {
    [$from, $to] = range_bounds();
    json_out(q('SELECT e.*, p.name AS project_name, p.color AS project_color
        FROM entries e JOIN projects p ON p.id = e.project_id
        WHERE e.started_at >= :f AND e.started_at < :t
        ORDER BY e.started_at DESC
        LIMIT 200', ['f' => $from, 't' => $to]));
}

if ($method === 'GET' && $path === '/summary') {
    [$from, $to] = range_bounds();
    // PDO + SQLite nedovoľuje použiť ten istý named parameter viackrát,
    // preto má každý výskyt vlastné meno.
    $now = now_ms();
    json_out(q('SELECT p.id AS project_id, p.name AS project_name, p.color AS project_color,
            SUM(MIN(COALESCE(e.ended_at, :now1), :t1) - MAX(e.started_at, :f1)) AS ms
        FROM entries e JOIN projects p ON p.id = e.project_id
        WHERE e.started_at < :t2 AND COALESCE(e.ended_at, :now2) > :f2
        GROUP BY p.id
        HAVING ms > 0
        ORDER BY ms DESC', [
        'f1' => $from, 'f2' => $from,
        't1' => $to, 't2' => $to,
        'now1' => $now, 'now2' => $now,
    ]));
}

if (preg_match('#^/entries/(\d+)$#', $path, $m)) {
    $id = (int) $m[1];
    if ($method === 'PATCH') {
        $allowed = ['note', 'started_at', 'ended_at', 'project_id', 'kimai_id'];
        $sets = [];
        $args = ['id' => $id];
        foreach ($allowed as $k) {
            if (array_key_exists($k, $BODY)) {
                $sets[] = "$k = :$k";
                $args[$k] = $BODY[$k];
            }
        }
        if ($sets) {
            run('UPDATE entries SET ' . implode(', ', $sets) . ' WHERE id = :id', $args);
        }
        $entry = get_entry($id);
        $kimaiError = null;
        if (kimai_enabled() && $entry && !empty($entry['kimai_id'])) {
            try {
                $payload = [
                    'description' => $entry['note'] ?? '',
                    'begin' => kimai_date((int) $entry['started_at']),
                ];
                if (!empty($entry['ended_at'])) {
                    $payload['end'] = kimai_date((int) $entry['ended_at']);
                }
                kimai_fetch('/api/timesheets/' . $entry['kimai_id'], 'PATCH', $payload);
            } catch (Throwable $e) {
                error_log('Kimai sync: ' . $e->getMessage());
                $kimaiError = $e->getMessage();
            }
        }
        json_out(array_merge($entry ?? [], ['kimaiError' => $kimaiError]));
    }
    if ($method === 'DELETE') {
        $entry = get_entry($id);
        $kimaiError = null;
        if (kimai_enabled() && $entry && !empty($entry['kimai_id'])) {
            try {
                kimai_fetch('/api/timesheets/' . $entry['kimai_id'], 'DELETE');
            } catch (Throwable $e) {
                error_log('Kimai sync: ' . $e->getMessage());
                $kimaiError = $e->getMessage();
            }
        }
        run('DELETE FROM entries WHERE id = :id', ['id' => $id]);
        json_out(['ok' => true, 'kimaiError' => $kimaiError]);
    }
}

fail('Nenájdené', 404);
