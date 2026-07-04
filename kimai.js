// Klient pre Kimai 2 REST API (Bearer token).
// Konfigurácia cez env: KIMAI_URL, KIMAI_API_TOKEN, voliteľne KIMAI_TIMEZONE.

const BASE = (process.env.KIMAI_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.KIMAI_API_TOKEN;
const TIMEZONE = process.env.KIMAI_TIMEZONE || 'Europe/Bratislava';

export const enabled = () => Boolean(BASE && TOKEN);

async function kfetch(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Kimai ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

// Kimai očakáva lokálny čas bez časovej zóny (HTML5 formát) v pásme
// používateľa — server ale beží v UTC, preto formátujeme explicitne.
export function toKimaiDate(ts) {
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(ts));
  return s.replace(' ', 'T');
}

export const listProjects = () => kfetch('/api/projects');

export const listActivities = (projectId) =>
  kfetch('/api/activities' + (projectId ? `?project=${projectId}` : ''));

export const startTimesheet = ({ begin, project, activity, description }) =>
  kfetch('/api/timesheets', {
    method: 'POST',
    body: JSON.stringify({ begin, project, activity, description }),
  });

export const updateTimesheet = (id, body) =>
  kfetch(`/api/timesheets/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

export const deleteTimesheet = (id) =>
  kfetch(`/api/timesheets/${id}`, { method: 'DELETE' });
