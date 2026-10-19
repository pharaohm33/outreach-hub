// Power dialer. "Start session" makes SignalWire call YOUR phone and keep you in a conference.
// Each lead is then dialed with answering-machine detection: a person is dropped into your call,
// a machine gets your recorded voicemail after the beep. You talk on your phone; this page runs the queue.
import { get, post } from '../api.js';
import { $, esc, fmtPhone, fullName, initials, fmtDuration, fmtDateTime, mergeFields, toast, confirmDialog, statusBadge } from '../util.js';

const DISPOSITIONS = [
  ['interested', 'Interested', 'good'], ['callback', 'Call back', ''], ['not_interested', 'Not interested', ''],
  ['no_answer', 'No answer / hung up', ''], ['wrong_number', 'Wrong number', 'danger'], ['dnc', 'Do not call', 'danger'],
];
const RING_TIMEOUT_MS = 150000;
const SESSION_RING_TIMEOUT_MS = 70000;
const TERMINAL = ['completed', 'failed', 'busy', 'no-answer', 'canceled'];

let root, ctx, S;

const fresh = () => ({
  phase: 'idle', // idle | starting | ready | dialing | connected | wrapup | between
  queue: [], cursor: 0, current: null, callRow: null, result: '', kind: '', notesDraft: '',
  recs: [], tags: [], settings: ctx.status.settings, log: [], agentPhone: '',
  pollTimer: null, sessionTimer: null, tickTimer: null, countdownTimer: null,
  countdown: 0, connectedAt: 0, dialStartedAt: 0, sessionStartedAt: 0,
});

/* ---------- helpers ---------- */
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
const stop = (k) => { clearInterval(S[k]); S[k] = null; };
const inSession = () => !['idle', 'starting'].includes(S.phase);

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
  if (inSession()) {
    el.innerHTML = `<span class="muted"><span class="dot on"></span>Your phone is connected</span> <button class="btn danger" data-act="end">End session</button>`;
  } else if (S.phase === 'starting') {
    el.innerHTML = '<span class="muted"><span class="dot pulse"></span>Calling your phone…</span>';
  } else {
    el.innerHTML = `<label class="inline"><input type="checkbox" id="consent"> I have the right to call these contacts and leave prerecorded voicemails</label>
       <button class="btn primary" data-act="start" id="start" disabled>Start session</button>`;
    const c = $('#consent', root);
    c.onchange = () => { $('#start', root).disabled = !c.checked; };
  }
}
function renderQueue() {
  $('#qcount', root).textContent = S.queue.length ? `${Math.max(0, S.queue.length - S.cursor)} left of ${S.queue.length}` : '';
  $('#queue', root).innerHTML = S.queue.length ? S.queue.slice(0, 150).map((c, i) => `
    <div class="q-item ${c === S.current && ['dialing', 'connected', 'wrapup'].includes(S.phase) ? 'current' : ''} ${c._done ? 'done' : ''}">
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
  if (/^(machine|fax)/.test(r.answered_by)) return r.vm_dropped ? 'Voicemail detected, playing your message…' : 'Machine detected, hanging up…';
  return 'Someone answered, connecting them to your phone…';
}

function renderPhone() {
  const el = $('#phone', root);
  if (!el) return;
  const c = S.current, nextC = S.queue[S.cursor];
  const script = c && S.settings.call_script ? mergeFields(S.settings.call_script, c) : '';
  const last = S.result ? `<div class="alert good" style="margin-bottom:14px">Last call: ${esc(S.result)}</div>` : '';
  let h = '';
  if (S.phase === 'idle') {
    h = `<div class="phone-card"><h2>Ready when you are</h2><p class="muted">Press <strong>Start session</strong> and your phone (${esc(fmtPhone(S.agentPhone) || 'set it in Settings')}) will ring. Answer it and stay on the line. Every lead who picks up is connected to you on that call, and answering machines get your voicemail automatically.</p></div>`;
  } else if (S.phase === 'starting') {
    h = `<div class="phone-card"><h2><span class="dot pulse"></span>Calling your phone…</h2><p class="muted">Answer the call to ${esc(fmtPhone(S.agentPhone))} and stay on the line. This page continues by itself.</p>
      <div class="call-actions"><button class="btn" data-act="end">Cancel</button></div></div>`;
  } else if (S.phase === 'ready') {
    h = `<div class="phone-card">${last}${nextC ? `${contactCard(nextC)}
      <div class="call-actions"><button class="btn primary lg" data-act="dial" ${windowOpen() ? '' : 'disabled title="Outside your calling hours"'}>&#9742; Dial ${esc(nextC.first_name || fmtPhone(nextC.phone))}</button>
      <button class="btn lg" data-act="skip">Skip</button></div>`
      : `<h2>${S.queue.length ? 'Queue finished' : 'Load a queue to begin'}</h2><p class="muted">${S.queue.length ? 'No one left to call in this list.' : 'Pick a list above and press Load queue.'}</p>`}</div>`;
  } else if (S.phase === 'dialing') {
    h = `<div class="phone-card">${contactCard(c)}<div class="state"><span class="dot pulse"></span><span id="dialtext">${esc(dialingText())}</span></div>
      <div class="call-actions"><button class="btn danger lg" data-act="cancel">Cancel call</button></div></div>`;
  } else if (S.phase === 'connected') {
    h = `<div class="phone-card">${contactCard(c)}
      <div class="timer" id="timer">0:00</div><div class="state" style="color:var(--good)">Connected: talk on your phone</div>
      <div class="call-actions">
        <button class="btn lg" data-act="vm" title="Their voicemail greeting was not detected? Play your recording now">Drop voicemail</button>
        <button class="btn danger solid lg" data-act="hangup">Hang up on lead</button></div>
      ${script ? `<div style="margin-top:16px;text-align:left"><div class="muted small">Script</div><div class="script-box">${esc(script)}</div></div>` : ''}
      <label style="text-align:left;margin:14px 0 0">Notes<textarea id="notes" rows="3" placeholder="What did they say?">${esc(S.notesDraft)}</textarea></label></div>`;
  } else if (S.phase === 'wrapup') {
    h = `<div class="phone-card">${contactCard(c)}<div class="state">Call ended${S.result ? ': ' + esc(S.result) : ''}</div>
      <label style="text-align:left;margin:14px 0 0">Notes<textarea id="notes" rows="3" placeholder="Anything to remember?">${esc(S.notesDraft)}</textarea></label>
      <div class="muted small" style="margin-top:12px">How did it go?</div>
      <div class="dispo">${DISPOSITIONS.map(([k, label, kind]) => `<button class="btn ${kind}" data-act="dispo" data-d="${k}">${label}</button>`).join('')}</div></div>`;
  } else if (S.phase === 'between') {
    h = `<div class="phone-card">${last}<h2>Next call in <span id="cd">${S.countdown}</span>s</h2>
      <div class="call-actions"><button class="btn primary lg" data-act="now">Dial now</button><button class="btn lg" data-act="pause">Pause auto-dial</button></div></div>`;
  }
  el.innerHTML = h;
}

async function renderLog() {
  try { S.log = await get('/calls?limit=8'); } catch { return; }
  const el = $('#log', root);
  if (!el) return;
  const label = (c) => c.disposition ? c.disposition.replace('_', ' ') : c.vm_dropped ? 'voicemail dropped' : c.status;
  el.innerHTML = S.log.length ? `<table><thead><tr><th>Contact</th><th>Result</th><th>Length</th><th>When</th></tr></thead><tbody>${S.log.map((c) => `<tr><td>${esc(c.first_name || c.last_name ? fullName(c) : c.to_number || '')}</td><td>${esc(label(c))}</td><td>${c.duration ? fmtDuration(c.duration) : ''}</td><td class="muted">${fmtDateTime(c.started_at)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No calls yet.</div>';
}

/* ---------- session (your phone) ---------- */
async function startSession() {
  S.phase = 'starting'; S.sessionStartedAt = Date.now();
  renderSessionBtn(); renderPhone();
  try {
    const r = await post('/dialer/session/start');
    S.agentPhone = r.agent_phone || S.agentPhone;
    renderPhone();
  } catch (e) {
    S.phase = 'idle'; renderSessionBtn(); renderPhone();
    return toast(e.message, 'error');
  }
  stop('sessionTimer');
  S.sessionTimer = setInterval(watchSession, 2000);
}

async function watchSession() {
  let r;
  try { r = await get('/dialer/session'); } catch { return; }
  if (!S) return;
  if (S.phase === 'starting') {
    if (r.status === 'active') {
      S.phase = 'ready';
      renderSessionBtn(); renderQueue(); renderPhone();
      toast(S.queue.length ? 'Phone connected. Ready to dial.' : 'Phone connected. Load a queue to begin.', 'success');
    } else if (r.status === 'ended' || Date.now() - S.sessionStartedAt > SESSION_RING_TIMEOUT_MS) {
      stop('sessionTimer');
      if (r.status !== 'ended') post('/dialer/session/end').catch(() => {});
      S.phase = 'idle'; renderSessionBtn(); renderPhone();
      toast('Your phone did not pick up. Check the number in Settings and try again.', 'error');
    }
  } else if (inSession() && r.status !== 'active') {
    stop('sessionTimer'); stop('pollTimer'); stop('tickTimer'); stop('countdownTimer');
    S.phase = 'idle'; S.current = null;
    renderSessionBtn(); renderQueue(); renderPhone();
    toast('Your phone disconnected. Start a new session to keep dialing.', 'error');
  }
}

async function endSession() {
  if (['dialing', 'connected'].includes(S.phase) && !(await confirmDialog('End session?', 'A call is in progress and will be hung up.', 'End session', true))) return;
  ['pollTimer', 'sessionTimer', 'tickTimer', 'countdownTimer'].forEach(stop);
  if (S.callRow && ['dialing', 'connected'].includes(S.phase)) post(`/calls/${S.callRow.id}/hangup`).catch(() => {});
  post('/dialer/session/end').catch(() => {});
  S.phase = 'idle'; S.current = null; S.callRow = null; S.result = '';
  renderSessionBtn(); renderQueue(); renderPhone();
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
    stop('pollTimer');
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
  if (!S || !S.callRow || !['dialing', 'connected'].includes(S.phase)) return;
  if (S.phase === 'dialing' && Date.now() - S.dialStartedAt > RING_TIMEOUT_MS) { post(`/calls/${S.callRow.id}/hangup`).catch(() => {}); return finish('Timed out', 'noanswer'); }
  let row;
  try { row = await get(`/calls/${S.callRow.id}`); } catch { return; }
  if (!S || !['dialing', 'connected'].includes(S.phase)) return;
  S.callRow = row;
  const ended = TERMINAL.includes(row.status);
  if (S.phase === 'connected') { if (ended) callEnded(row); return; }
  if (ended) {
    if (row.status !== 'completed') return finish({ busy: 'Busy', 'no-answer': 'No answer', failed: 'Call failed', canceled: 'Cancelled' }[row.status], 'noanswer');
    if (row.vm_dropped) return finish('Voicemail dropped', 'vm');
    if (/^(machine|fax)/.test(row.answered_by || '')) return finish('Answering machine, hung up', 'vm');
    if (row.connected_at) return callEnded(row); // a short conversation that finished between polls
    return finish('They answered but nobody was there to take it', 'noanswer');
  }
  if (row.connected_at && !row.vm_dropped) return enterConnected();
  const t = $('#dialtext', root);
  if (t) t.textContent = dialingText();
}

function enterConnected() {
  S.phase = 'connected'; S.connectedAt = Date.now(); S.notesDraft = '';
  stop('tickTimer');
  S.tickTimer = setInterval(() => { const t = $('#timer', root); if (t) t.textContent = fmtDuration((Date.now() - S.connectedAt) / 1000); }, 500);
  renderQueue(); renderPhone();
  toast('Connected. Talk on your phone.', 'success');
}

function callEnded(row) {
  stop('pollTimer'); stop('tickTimer');
  S.notesDraft = $('#notes', root)?.value || S.notesDraft;
  S.result = fmtDuration(row.duration || (S.connectedAt ? (Date.now() - S.connectedAt) / 1000 : 0));
  S.phase = 'wrapup';
  if (S.current) S.current._done = true;
  renderQueue(); renderPhone(); renderLog();
}

function finish(text, kind) {
  stop('pollTimer'); stop('tickTimer');
  S.result = text; S.kind = kind;
  if (S.current) S.current._done = true;
  renderLog();
  afterCall();
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

async function dispose(d) {
  const notes = $('#notes', root)?.value.trim() || '';
  try {
    await post(`/calls/${S.callRow.id}/disposition`, { disposition: d, notes });
    if (S.current) {
      if (d === 'dnc' || d === 'wrong_number') S.current.status = d;
      if (notes) S.current.notes = (S.current.notes ? S.current.notes + '\n' : '') + notes;
    }
    S.result = DISPOSITIONS.find((x) => x[0] === d)[1];
    renderLog();
    afterCall();
  } catch (e) { toast(e.message, 'error'); }
}

async function dropVoicemail() {
  try {
    await post(`/calls/${S.callRow.id}/voicemail`, { recording_id: $('#o-rec', root).value });
    toast('Playing your voicemail to them', 'success');
    S.callRow.vm_dropped = 1;
    finish('Voicemail dropped', 'vm');
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
      case 'hangup': await post(`/calls/${S.callRow.id}/hangup`); return await poll();
      case 'vm': return await dropVoicemail();
      case 'dispo': return await dispose(b.dataset.d);
    }
  } catch (err) { toast(err.message, 'error'); }
}

export default {
  async mount(r, c, params) {
    root = r; ctx = c;
    S = fresh();
    const [recs, tags, settings, session] = await Promise.all([get('/recordings'), get('/tags'), get('/settings'), get('/dialer/session')]);
    S.recs = recs; S.tags = tags; S.settings = settings; ctx.status.settings = settings;
    S.agentPhone = session.agent_phone || settings.agent_phone;
    if (session.status === 'active') S.phase = 'ready'; // session survives page changes
    renderShell();
    root.onclick = onClick;
    if (S.phase === 'ready') S.sessionTimer = setInterval(watchSession, 2000);
    const want = Number(params.get('c'));
    if (want) {
      try { const d = await get(`/contacts/${want}/messages`); S.queue = [d.contact]; renderQueue(); renderPhone(); toast(`${fullName(d.contact)} loaded.${S.phase === 'ready' ? '' : ' Start a session to call.'}`); } catch (e) { toast(e.message, 'error'); }
    }
  },
  canLeave() {
    if (S && ['dialing', 'connected'].includes(S.phase)) return window.confirm('A call is in progress. Leave this page? The call will be hung up.');
    return true;
  },
  unmount() {
    if (!S) return;
    ['pollTimer', 'sessionTimer', 'tickTimer', 'countdownTimer'].forEach(stop);
    if (S.callRow && ['dialing', 'connected'].includes(S.phase)) post(`/calls/${S.callRow.id}/hangup`).catch(() => {});
    root.onclick = null;
    S = null; // the phone session itself stays up until you press End session or hang up
  },
};
