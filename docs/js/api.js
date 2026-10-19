// Talks to your Cloudflare Worker. The URL and password live only in this browser's localStorage.
const KEY = 'outreach-hub.config';

export const config = {
  get() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
  },
  set(c) {
    try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* private mode: stays in memory only */ memory = c; }
  },
  clear() {
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
    memory = null;
  },
};
let memory = null;
const cfg = () => memory || config.get();

export const workerUrl = () => (cfg().url || '').replace(/\/+$/, '');

export async function api(method, path, body) {
  const { password } = cfg();
  let res;
  try {
    res = await fetch(workerUrl() + '/api' + path, {
      method,
      headers: { Authorization: 'Bearer ' + (password || ''), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Cannot reach your Worker. Check the URL, your connection, and that ALLOWED_ORIGIN includes this site.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event('auth-failed'));
    const e = new Error(data?.error || `Request failed (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return data;
}
export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b = {}) => api('PUT', p, b);
export const del = (p) => api('DELETE', p);
export const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
};
