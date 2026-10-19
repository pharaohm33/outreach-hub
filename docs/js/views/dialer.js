// Power dialer: your browser is the phone (Twilio Voice SDK). The Worker places each call to the lead,
// Twilio's answering-machine detection decides who picked up, then either rings your browser (a person)
// or plays your recorded voicemail (a machine) and hangs up.
import { get, post } from '../api.js';
import { $, esc, fmtPhone, fullName, initials, fmtDuration, fmtDateTime, mergeFields, loadScript, toast, confirmDialog, statusBadge } from '../util.js';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@twilio/voice-sdk@2.12.0/dist/twilio.min.js';
const DISPOSITIONS = [
  ['interested', 'Interested', 'good'], ['callback', 'Call back', ''], ['not_interested', 'Not interested', ''],
  ['no_answer', 'No answer / hung up', ''], ['wrong_number', 'Wrong number', 'danger'], ['dnc', 'Do not call', 'danger'],
];
const RING_TIMEOUT_MS = 150000;

let root, ctx, S;

const fresh = () => ({
  phase: 'idle', // idle | starting | ready | dialing | connected | wrapup | between
  device: null, call: null, queue: [], cursor: 0, current: null, callRow: null, result: '', kind: '',
  recs: [], tags: [], settings: ctx.status.settings, log: [],
  pollTimer: null, tickTimer: null, countdownTimer: null, countdown: 0, connectedAt: 0, dialStartedAt: 0, muted: false, label: '', incoming: null,
});

/* ---------- helpers ---------- */
const sdk = async () => { if (!window.Twilio?.Device) await loadScript(SDK_URL); return window.Twilio.Device; };
const opts = () => ({
  tag: $('#o-tag', root).value, maxAttempts: $('#o-attempts', root).value, minHours: $('#o-hours', root).value,
  autoVm: $('#o-vm', root).checked, recId: $('#o-rec', root).value, autoDial: $('#o-auto', root).checked, delay: Math.max(1, Number($('#o-delay', root).value) || 3),
});
function windowOpen() {
  const s = S.settings;
  try {
    const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: s.timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
    return h >= s.window_start && h < s.window_end;
  } catch { return true; }
}
const stop = (k) => { clearInterval(S[k]); clearTimeout(S[k]); S[k] = null; };

/* ---------- rendering ---------- */
function renderShell() {
  const s = S.settings;
  root.innerHTML = `
    <div class="page-head"><div><h1>Dialer</h1><div class="sub" id="chip"></div></div><div class="row" id="session-btn"></div></div>
    <div class="card" style="margin-bottom:14px">
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));align-items:end">
        <label style="margin:0">List (tag)<select id="o-tag"><option value="">Everyone</option>${S.tags.map((t) => `<option>${esc(t)}</option>`).join('')}</select></label>
        <label style="margin:0">Max attempts<input id="o-attempts" type="number" min="1" value="${s.max_attempts}"></label>
        <label style="margin:0">Skip if called within (hours)<input id="o-hours" type="number" min="0" value="${s.min_hours}"></label>
        <div><button class="btn" data-act="load">Load queue</button></div>
      </div>
      <hr style="border:0;border-top:1px solid var(--line);margin:14px 0">
      <div class="row" style="gap:22px">
        <div class="row"><label class="inline"><input type="checkbox" id="o-vm" ${s.auto_vm && S.recs.length ? 'checked' : ''} ${S.recs.length ? '' : 'disabled'}> Drop voicemail on machines:</label>
          ${S.recs.length ? `<select id="o-rec" style="width:auto">${S.recs.map((r) => `<option value="${r.id}" ${r.id === s.default_recording_id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>` : '<input type="hidden" id="o-rec"><a href="#/voicemails">Record a voicemail first</a>'}</div>
        <div class="row"><label class="inline"><input type="checkbox" id="o-auto"> Auto-dial next lead after</label><input id="o-delay" type="number" min="1" max="60" value="3" style="width:64px"> seconds</div>
      </div>
    </div>
    <div class="dialer">
      <div class="card flush"><div style="padding:14px 14px 8px" class="row"><h2 style="margin:0">Queue</h2><span class="muted small" id="qcount"></span></div><div class="queue-list" id="queue"></div></div>
      <div>
        <div class="card" id="phone"></div>
        <div class="card flush" style="margin-top:14px"><div style="padding:14px 14px 0"><h2>Recent calls</h2></div><div class="table-wrap" id="log"></div></div>
      </div>
    </div>`;
  renderChip(); renderSessionBtn(); renderQueue(); renderPhone(); renderLog();
}

function renderChip() {
  const open = windowOpen(), s = S.settings;
  $('#chip', root).innerHTML = `<span class="dot ${open ? 'on' : ''}"></span>Calling hours ${open ? 'open' : 'closed'} (${s.window_start}:00 to ${s.window_end}:00 ${esc(s.timezone)})`;
}
function renderSessionBtn() {
  const el = $('#session-btn', root);
  const live = !['idle', 'starting'].includes(S.phase);
  el.innerHTML = live ? '<span class="muted"><span class="dot on"></span>Phone connected</span> <button class="btn danger" data-act="end">End session</button>'
    : `<label class="inline"><input type="checkbox" id="consent"> I have the right to call these contacts and leave prerecorded voicemails</label>
       <button class="btn primary" data-act="start" id="start" disabled>${S.phase === 'starting' ? 'Connecting…' : 'Start session'}</button>`;
  const c = $('#consent', root);
  if (c) c.onchange = () => { $('#start', root).disabled = !c.checked || S.phase === 'starting'; };
}
function renderQueue() {
  $('#qcount', root).textContent = S.queue.length ? `${Math.max(0, S.queue.length - S.cursor)} left of ${S.queue.length}` : '';
  $('#queue', root).innerHTML = S.queue.length ? S.queue.slice(0, 150).map((c, i) => `
    <div class="q-item ${c === S.current && !['ready', 'between', 'idle'].includes(S.phase) ? 'current' : ''} ${c._done ? 'done' : ''}">
      <span class="avatar">${esc(initials(c))}</span><div style="min-width:0;flex:1"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><strong>${esc(fullName(c))}</strong></div>
      <div class="muted small">${esc(fmtPhone(c.phone))}${c.call_attempts ? ` &middot; tried ${c.call_attempts}x` : ''}</div></div>
      ${i === S.cursor && !c._done && S.phase === 'ready' ? '<span class="badge">next</span>' : ''}${c.status === 'callback' ? '<span class="badge s-callback">callback</span>' : ''}</div>`).join('')
    : '<div class="empty">Choose a list and press Load queue.</div>';
}
function contactCard(c) {
  return `<span class="avatar" style="width:64px;height:64px;font-size:20px;margin:0 auto">${esc(initials(c))}</span>
    <div class="big">${esc(fullName(c))}</div><div class="muted">${esc(fmtPhone(c.phone))}${c.company ? ' &middot; ' + esc(c.company) : ''}</div>
    <div style="margin-top:6px">${statusBadge(c.status)}${c.call_attempts ? ` <span class="badge">${c.call_attempts} attempt${c.call_attempts === 1 ? '' : 's'}</span>` : ''}</div>`;
}
function dialingText() {
  const r = S.callRow;
  if (!r || !r.answered_by) return 'Calling… ringing, then checking who answered';
  if (/machine|fax/.test(r.answered_by)) return r.vm_dropped ? 'Voicemail detected, playing your message…' : 'Machine detected, hanging up…';
  return 'Someone answered, connecting you…';
}

function renderPhone() {
  const el = $('#phone', root);
  if (!el) return;
  const c = S.current, nextC = S.queue[S.cursor];
  const script = c && S.settings.call_script ? mergeFields(S.settings.call_script, c) : '';
  const last = S.result ? `<div class="alert good" style="margin-bottom:14px">Last call: ${esc(S.result)}</div>` : '';
  let h = '';
  if (S.phase === 'idle' || S.phase === 'starting') {
    h = `<div class="phone-card"><h2>Ready when you are</h2><p class="muted">Start a session to connect your browser as the phone. Your computer's microphone and speakers are used. Load a queue, then dial.</p></div>`;
  } else if (S.phase === 'ready') {
    h = `<div class="phone-card">${last}${nextC ? `${contactCard(nextC)}
      <div class="call-actions"><button class="btn primary lg" data-act="dial" ${windowOpen() ? '' : 'disabled title="Outside your calling hours"'}>&#9742; Dial ${esc(nextC.first_name || fmtPhone(nextC.phone))}</button>
      <button class="btn lg" data-act="skip">Skip</button></div>`
      : `<h2>${S.queue.length ? 'Queue finished' : 'Load a queue to begin'}</h2><p class="muted">${S.queue.length ? 'No one left to call in this list.' : 'Pick a list above and press Load queue.'}</p>`}
      <div class="row" style="justify-content:center;margin-top:18px"><input id="manual" placeholder="Or dial any number" style="max-width:200px"><button class="btn" data-act="manual">Dial</button></div></div>`;
  } else if (S.phase === 'dialing') {
    h = `<div class="phone-card">${contactCard(c)}<div class="state"><span class="dot pulse"></span><span id="dialtext">${esc(dialingText())}</span></div>
      <div class="call-actions"><button class="btn danger lg" data-act="cancel">Cancel call</button></div></div>`;
  } else if (S.phase === 'connected') {
    h = `<div class="phone-card">${c ? contactCard(c) : `<div class="big">${esc(S.label || 'Call')}</div>`}
      <div class="timer" id="timer">0:00</div><div class="state" style="color:var(--good)">Connected</div>
      <div class="call-actions">
        <button class="btn lg" data-act="mute">${S.muted ? 'Unmute' : 'Mute'}</button>
        ${S.callRow && S.callRow.kind === 'auto' ? '<button class="btn lg" data-act="vm" title="Their voicemail greeting was not detected? Play your recording now">Drop voicemail</button>' : ''}
        <button class="btn danger solid lg" data-act="hangup">Hang up</button></div>
      ${script ? `<div style="margin-top:16px;text-align:left"><div class="muted small">Script</div><div class="script-box">${esc(script)}</div></div>` : ''}
      ${S.callRow ? `<label style="text-align:left;margin:14px 0 0">Notes<textarea id="notes" rows="3" placeholder="What did they say?">${esc(c?.notes || '')}</textarea></label>` : ''}</div>`;
  } else if (S.phase === 'wrapup') {
    h = `<div class="phone-card">${c ? contactCard(c) : `<div class="big">${esc(S.label || 'Call')}</div>`}<div class="state">Call ended${S.result ? ': ' + esc(S.result) : ''}</div>
      ${S.callRow ? `<label style="text-align:left;margin:14px 0 0">Notes<textarea id="notes" rows="3" placeholder="Anything to remember?">${esc(S.notesDraft || '')}</textarea></label>
      <div class="muted small" style="margin-top:12px">How did it go?</div>
      <div class="dispo">${DISPOSITIONS.map(([k, label, kind]) => `<button class="btn ${kind}" data-act="dispo" data-d="${k}">${label}</button>`).join('')}</div>`
      : '<div class="call-actions"><button class="btn primary lg" data-act="done">Done</button></div>'}</div>`;
  } else if (S.phase === 'between') {
    h = `<div class="phone-card">${last}<h2>Next call in <span id="cd">${S.countdown}</span>s</h2>
      <div class="call-actions"><button class="btn primary lg" data-act="now">Dial now</button><button class="btn lg" data-act="pause">Pause auto-dial</button></div></div>`;
  }
  el.innerHTML = h;
  if (S.incoming) renderIncoming();
}

function renderIncoming() {
  $('.incoming-bar')?.remove();
  if (!S.incoming) return;
  const bar = document.createElement('div');
  bar.className = 'incoming-bar';
  bar.innerHTML = `<strong>Incoming call ${esc(fmtPhone(S.incoming.parameters?.From || ''))}</strong><button class="btn good" data-act="answer">Answer</button><button class="btn danger" data-act="decline">Decline</button>`;
  root.appendChild(bar);
}

async function renderLog() {
  try { S.log = await get('/calls?limit=8'); } catch { return; }
  const el = $('#log', root);
  if (!el) return;
  const label = (c) => c.disposition ? c.disposition.replace('_', ' ') : c.vm_dropped ? 'voicemail dropped' : c.status;
  el.innerHTML = S.log.length ? `<table><thead><tr><th>Contact</th><th>Result</th><th>Length</th><th>When</th></tr></thead><tbody>${S.log.map((c) => `<tr><td>${esc(c.first_name || c.last_name ? fullName(c) : c.to_number || '')}</td><td>${esc(label(c))}</td><td>${c.duration ? fmtDuration(c.duration) : ''}</td><td class="muted">${fmtDateTime(c.started_at)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No calls yet.</div>';
}

/* ---------- session ---------- */
async function startSession() {
  S.phase = 'starting'; renderSessionBtn();
  try {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => { throw new Error('Allow microphone access in your browser to make calls.'); });
    mic.getTracks().forEach((t) => t.stop());
    const Device = await sdk();
    const { token } = await post('/voice/token');
    const device = new Device(token, { codecPreferences: ['opus', 'pcmu'], closeProtection: true, logLevel: 'error' });
    device.on('error', (e) => toast(`Phone error: ${e.message || e}`, 'error'));
    device.on('incoming', onIncoming);
    device.on('tokenWillExpire', async () => { try { device.updateToken((await post('/voice/token')).token); } catch { /* retry on next event */ } });
    await new Promise((resolve, reject) => {
      device.on('registered', resolve);
      device.register().catch(reject);
      setTimeout(() => reject(new Error('Timed out connecting to Twilio.')), 15000);
    });
    S.device = device;
    S.phase = 'ready';
    renderSessionBtn(); renderQueue(); renderPhone();
    if (!S.queue.length) toast('Phone connected. Load a queue to begin.', 'success');
  } catch (e) {
    S.phase = 'idle';
    try { S.device?.destroy(); } catch { /* ignore */ }
    S.device = null;
    renderSessionBtn(); renderPhone();
    toast(e.message, 'error');
  }
}

async function endSession(force = false) {
  if (!force && ['dialing', 'connected'].includes(S.phase) && !(await confirmDialog('End session?', 'A call is in progress and will be hung up.', 'End session', true))) return;
  await teardown();
  S.phase = 'idle'; S.current = null; S.callRow = null; S.result = '';
  renderSessionBtn(); renderQueue(); renderPhone();
}
async function teardown() {
  ['pollTimer', 'tickTimer', 'countdownTimer'].forEach(stop);
  if (S.callRow && S.phase === 'dialing') post(`/calls/${S.callRow.id}/hangup`).catch(() => {});
  try { S.call?.disconnect(); } catch { /* ignore */ }
  try { S.device?.destroy(); } catch { /* ignore */ }
  S.device = S.call = S.incoming = null;
  $('.incoming-bar')?.remove();
}

/* ---------- queue ---------- */
async function loadQueue() {
  const o = opts();
  const r = await get(`/dialer/queue?tag=${encodeURIComponent(o.tag)}&max_attempts=${o.maxAttempts}&min_hours=${o.minHours}`);
  S.queue = r.contacts; S.cursor = 0; S.current = null; S.result = '';
  renderQueue(); renderPhone();
  toast(`${r.total} contact${r.total === 1 ? '' : 's'} ready to call${r.total > r.contacts.length ? ` (showing the first ${r.contacts.length})` : ''}`);
}

/* ---------- calling ---------- */
async function dial() {
  const c = S.queue[S.cursor];
  if (!c) { toast('Queue finished', 'success'); S.phase = 'ready'; renderQueue(); renderPhone(); return; }
  const o = opts();
  S.current = c; S.cursor++; S.result = ''; S.notesDraft = '';
  try {
    const r = await post('/dialer/call', { contact_id: c.id, auto_vm: o.autoVm, recording_id: o.recId });
    S.callRow = r.call;
    Object.assign(c, r.contact);
    S.phase = 'dialing'; S.dialStartedAt = Date.now();
    S.pollTimer = setInterval(poll, 1500);
    renderQueue(); renderPhone();
  } catch (e) {
    toast(e.message, 'error');
    S.cursor--; S.current = null; S.phase = 'ready';
    $('#o-auto', root).checked = false;
    renderQueue(); renderPhone();
  }
}

async function poll() {
  if (!S.callRow || S.phase !== 'dialing') return;
  if (Date.now() - S.dialStartedAt > RING_TIMEOUT_MS) { post(`/calls/${S.callRow.id}/hangup`).catch(() => {}); return finish('Timed out', 'noanswer'); }
  let row;
  try { row = await get(`/calls/${S.callRow.id}`); } catch { return; }
  if (S.phase !== 'dialing') return;
  S.callRow = row;
  if (['no-answer', 'busy', 'failed', 'canceled'].includes(row.status)) {
    return finish({ busy: 'Busy', 'no-answer': 'No answer', failed: 'Call failed', canceled: 'Cancelled' }[row.status], 'noanswer');
  }
  if (row.status === 'completed') {
    if (row.vm_dropped) return finish('Voicemail dropped', 'vm');
    if (/machine|fax/.test(row.answered_by || '')) return finish('Answering machine, hung up', 'vm');
    return finish('They answered but the call could not reach you', 'noanswer');
  }
  const t = $('#dialtext', root);
  if (t) t.textContent = dialingText();
}

function finish(text, kind) {
  ['pollTimer', 'tickTimer'].forEach(stop);
  S.result = text; S.kind = kind;
  if (S.current) S.current._done = true;
  renderLog();
  if (kind === 'conversation') { S.phase = 'wrapup'; renderQueue(); renderPhone(); } else afterCall();
}

function afterCall() {
  stop('countdownTimer');
  const o = opts();
  const more = S.cursor < S.queue.length;
  if (o.autoDial && more && windowOpen()) {
    S.phase = 'between'; S.countdown = o.delay;
    S.countdownTimer = setInterval(() => {
      S.countdown--;
      const el = $('#cd', root);
      if (el) el.textContent = S.countdown;
      if (S.countdown <= 0) { stop('countdownTimer'); dial(); }
    }, 1000);
  } else {
    if (o.autoDial && more && !windowOpen()) { $('#o-auto', root).checked = false; toast('Auto-dial paused: outside your calling hours', 'error'); }
    S.phase = 'ready';
  }
  renderQueue(); renderPhone();
}

function onIncoming(call) {
  // A person answered the lead call: Twilio is now ringing this browser. Take it straight away.
  if (S.phase === 'dialing' && S.callRow) { accept(call); return; }
  if (S.call || ['connected', 'wrapup'].includes(S.phase)) { call.reject(); return; }
  S.incoming = call;
  call.on('cancel', () => { S.incoming = null; $('.incoming-bar')?.remove(); });
  renderIncoming();
}

function accept(call) {
  stop('pollTimer');
  S.call = call; S.muted = false; S.connectedAt = Date.now();
  S.label = S.current ? '' : fmtPhone(call.parameters?.From || '') || 'Incoming call';
  call.on('disconnect', onDisconnect);
  call.on('error', (e) => toast(`Call error: ${e.message || e}`, 'error'));
  call.accept();
  S.phase = 'connected';
  S.tickTimer = setInterval(() => { const t = $('#timer', root); if (t) t.textContent = fmtDuration((Date.now() - S.connectedAt) / 1000); }, 500);
  renderQueue(); renderPhone();
}

function onDisconnect() {
  stop('tickTimer');
  S.call = null;
  if (S.phase !== 'connected') return;
  S.notesDraft = $('#notes', root)?.value || '';
  S.result = fmtDuration((Date.now() - S.connectedAt) / 1000);
  S.phase = 'wrapup';
  renderPhone();
  renderLog();
}

async function dispose(d) {
  const notes = $('#notes', root)?.value.trim() || '';
  try {
    if (S.callRow) {
      await post(`/calls/${S.callRow.id}/disposition`, { disposition: d, notes });
      if (S.current) { S.current.status = d === 'dnc' || d === 'wrong_number' ? d : S.current.status; if (notes) S.current.notes = (S.current.notes ? S.current.notes + '\n' : '') + notes; }
    }
    S.result = DISPOSITIONS.find((x) => x[0] === d)[1];
    if (S.current) S.current._done = true;
    renderLog();
    afterCall();
  } catch (e) { toast(e.message, 'error'); }
}

async function dropVoicemail() {
  try {
    await post(`/calls/${S.callRow.id}/voicemail`, { recording_id: $('#o-rec', root).value });
    toast('Playing your voicemail to them', 'success');
    S.callRow.vm_dropped = 1;
    try { S.call?.disconnect(); } catch { /* ignore */ }
    stop('tickTimer'); S.call = null;
    finish('Voicemail dropped', 'vm');
  } catch (e) { toast(e.message, 'error'); }
}

async function manualDial() {
  const to = $('#manual', root).value.trim();
  if (!to) return;
  try {
    const call = await S.device.connect({ params: { To: to } });
    S.current = null; S.callRow = null; S.result = '';
    S.label = `Calling ${to}`;
    S.call = call; S.muted = false; S.connectedAt = Date.now();
    call.on('disconnect', onDisconnect);
    call.on('error', (e) => toast(`Call error: ${e.message || e}`, 'error'));
    S.phase = 'connected';
    S.tickTimer = setInterval(() => { const t = $('#timer', root); if (t) t.textContent = fmtDuration((Date.now() - S.connectedAt) / 1000); }, 500);
    renderPhone();
  } catch (e) { toast(e.message, 'error'); }
}

async function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  try {
    switch (b.dataset.act) {
      case 'start': return await startSession();
      case 'end': return await endSession();
      case 'load': return await loadQueue();
      case 'dial': return await dial();
      case 'now': stop('countdownTimer'); return await dial();
      case 'pause': stop('countdownTimer'); $('#o-auto', root).checked = false; S.phase = 'ready'; return renderPhone();
      case 'skip': if (S.queue[S.cursor]) S.queue[S.cursor]._done = true; S.cursor++; renderQueue(); return renderPhone();
      case 'cancel': await post(`/calls/${S.callRow.id}/hangup`); return finish('Cancelled', 'noanswer');
      case 'hangup': S.call?.disconnect(); return;
      case 'mute': S.muted = !S.muted; S.call?.mute(S.muted); b.textContent = S.muted ? 'Unmute' : 'Mute'; return;
      case 'vm': return await dropVoicemail();
      case 'dispo': return await dispose(b.dataset.d);
      case 'done': S.phase = 'ready'; S.label = ''; return renderPhone();
      case 'manual': return await manualDial();
      case 'answer': { const c = S.incoming; S.incoming = null; $('.incoming-bar')?.remove(); return accept(c); }
      case 'decline': S.incoming?.reject(); S.incoming = null; return $('.incoming-bar')?.remove();
    }
  } catch (err) { toast(err.message, 'error'); }
}

export default {
  async mount(r, c, params) {
    root = r; ctx = c;
    S = fresh();
    const [recs, tags, settings] = await Promise.all([get('/recordings'), get('/tags'), get('/settings')]);
    S.recs = recs; S.tags = tags; S.settings = settings; ctx.status.settings = settings;
    renderShell();
    root.onclick = onClick;
    root.onkeydown = (e) => { if (e.target.id === 'manual' && e.key === 'Enter') manualDial(); };
    const want = Number(params.get('c'));
    if (want) {
      try { const d = await get(`/contacts/${want}/messages`); S.queue = [d.contact]; renderQueue(); renderPhone(); toast(`${fullName(d.contact)} loaded. Start a session to call.`); } catch (e) { toast(e.message, 'error'); }
    }
  },
  canLeave() {
    if (S && ['dialing', 'connected'].includes(S.phase)) return window.confirm('A call is in progress. Leave this page and hang up?');
    return true;
  },
  unmount() {
    if (!S) return;
    teardown();
    $('.incoming-bar')?.remove();
    root.onclick = root.onkeydown = null;
    S = null;
  },
};
