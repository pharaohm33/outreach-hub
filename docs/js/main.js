import { get, config, workerUrl } from './api.js';
import { $, esc, toast } from './util.js';

const VIEWS = {
  dashboard: { label: 'Dashboard', load: () => import('./views/dashboard.js') },
  contacts: { label: 'Contacts', load: () => import('./views/contacts.js') },
  inbox: { label: 'Inbox', load: () => import('./views/inbox.js') },
  campaigns: { label: 'SMS Campaigns', load: () => import('./views/campaigns.js') },
  dialer: { label: 'Dialer', load: () => import('./views/dialer.js') },
  voicemails: { label: 'Voicemails', load: () => import('./views/voicemails.js') },
  settings: { label: 'Settings', load: () => import('./views/settings.js') },
};

const ctx = {
  status: null,
  unread: 0,
  go(hash) { location.hash = hash; },
  async refreshStatus() { ctx.status = await get('/status'); renderBanner(); return ctx.status; },
  signOut() { config.clear(); showLogin(); },
};
let current = null; // { name, mod }
let lastHash = '#/dashboard';
let navToken = 0;

function showLogin(message = '') {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-error').textContent = message;
  const c = config.get();
  const f = $('#login-form');
  if (c.url) f.url.value = c.url;
}

function renderNav(active) {
  $('#nav').innerHTML = Object.entries(VIEWS).map(([k, v]) =>
    `<a href="#/${k}" class="${k === active ? 'active' : ''}">${esc(v.label)}${k === 'inbox' && ctx.unread ? `<span class="pill">${ctx.unread}</span>` : ''}</a>`).join('');
  $('#conn').textContent = workerUrl().replace(/^https?:\/\//, '');
}

function renderBanner() {
  const s = ctx.status;
  const el = $('#banner');
  if (!s) { el.innerHTML = ''; return; }
  let msg = '';
  if (!s.configured) msg = 'Your Worker has no SignalWire credentials yet. Add <code>SIGNALWIRE_SPACE</code>, <code>SIGNALWIRE_PROJECT_ID</code> and <code>SIGNALWIRE_API_TOKEN</code> as secrets, then <a href="#/settings">finish setup in Settings</a>.';
  else if (!s.voice_ready || !s.sms_ready) msg = 'Almost there: <a href="#/settings">pick your SignalWire number and add your cell phone in Settings</a> to enable texting and calling.';
  el.innerHTML = msg ? `<div class="alert">${msg}</div>` : '';
}

async function route() {
  const token = ++navToken;
  const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [name, query = ''] = raw.split('?');
  const def = VIEWS[name] || VIEWS.dashboard;
  const key = VIEWS[name] ? name : 'dashboard';

  if (current?.mod.canLeave && !current.mod.canLeave()) {
    history.replaceState(null, '', lastHash); // stay put, e.g. during a live call
    return;
  }
  if (current?.mod.unmount) { try { current.mod.unmount(); } catch (e) { console.error(e); } }
  current = null;
  lastHash = location.hash || '#/dashboard';
  renderNav(key);
  const root = $('#view');
  root.innerHTML = '<p class="muted">Loading&hellip;</p>';
  try {
    const mod = (await def.load()).default;
    if (token !== navToken) return;
    root.innerHTML = '';
    current = { name: key, mod };
    await mod.mount(root, ctx, new URLSearchParams(query));
  } catch (e) {
    console.error(e);
    if (token === navToken) root.innerHTML = `<div class="alert bad">Could not load this page: ${esc(e.message)}</div>`;
  }
}

async function pollUnread() {
  if (document.hidden || $('#app').hidden) return;
  try {
    const st = await get('/stats');
    if (st.unread !== ctx.unread) { ctx.unread = st.unread; renderNav(current?.name); }
  } catch { /* ignore transient errors */ }
}

async function enter() {
  try {
    await ctx.refreshStatus();
  } catch (e) {
    showLogin(e.status === 401 ? 'Wrong password.' : e.message);
    return false;
  }
  $('#login').hidden = true;
  $('#app').hidden = false;
  await route();
  pollUnread();
  return true;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  config.set({ url: f.url.value.trim().replace(/\/+$/, ''), password: f.password.value });
  const btn = f.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  const ok = await enter();
  btn.disabled = false;
  btn.textContent = 'Connect';
  if (ok) f.password.value = '';
});
window.addEventListener('auth-failed', () => showLogin('Your password was rejected. Sign in again.'));
window.addEventListener('hashchange', route);
setInterval(pollUnread, 20000);

if (config.get().url) enter(); else showLogin();
