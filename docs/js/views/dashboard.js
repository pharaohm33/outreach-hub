import { get } from '../api.js';
import { esc, fullName, fmtDateTime, fmtDuration, toast } from '../util.js';

const CALL_LABEL = (c) => {
  if (c.vm_dropped) return '<span class="badge s-voicemailed">Voicemail dropped</span>';
  if (c.answered_by === 'human') return '<span class="badge green">Answered</span>';
  if (c.status === 'no-answer' || c.status === 'busy' || c.status === 'failed' || c.status === 'canceled') return '<span class="badge">No answer</span>';
  if (c.answered_by) return '<span class="badge">Machine</span>';
  return `<span class="badge">${esc(c.status)}</span>`;
};

const TICK = { done: '&#10003;', waiting: '&hellip;', problem: '!', todo: '' };
function regCard(r) {
  if (!r) return '<h2>Texting approval</h2><p class="muted">Checking with SignalWire&hellip;</p>';
  const steps = (r.steps || []).map((x) => `<li><span class="tick ${x.state === 'done' ? 'ok' : ''}" style="${x.state === 'waiting' ? 'background:var(--warn);border-color:var(--warn)' : x.state === 'problem' ? 'background:var(--bad);border-color:var(--bad)' : ''}">${TICK[x.state]}</span>
    <div><strong>${esc(x.label)}</strong><div class="muted small">${{ done: 'Done', waiting: 'In review', problem: 'Needs attention', todo: 'Not done yet' }[x.state]}</div></div></li>`).join('');
  return `<div class="row" style="justify-content:space-between"><h2 style="margin:0">Texting approval</h2>
      <span class="row"><button class="btn sm" data-act="reg-refresh">Check again</button></span></div>
    <div class="alert ${r.ready ? 'good' : r.overall === 'unknown' || r.overall.endsWith('inactive') || r.overall.endsWith('unverified') || r.overall === 'number_failed' ? 'bad' : ''}" style="margin:12px 0">${esc(r.message || 'Could not check.')}</div>
    ${steps ? `<ul class="steps">${steps}</ul>` : ''}
    <p class="muted small" style="margin:10px 0 0">Checked each time you open this app. <a href="${esc(r.dashboard_url)}" target="_blank" rel="noopener">Open the SignalWire registry</a>.
      ${r.number_sms === false ? ' Your number does not report SMS capability yet.' : ''}</p>`;
}

export default {
  async mount(root, ctx) {
    const [st, calls, recs, contacts] = await Promise.all([
      get('/stats'), get('/calls?limit=8'), get('/recordings'), get('/contacts?limit=1'),
    ]);
    const s = ctx.status;
    const steps = [
      [s.configured, 'SignalWire credentials added to your Worker', 'Add <code>SIGNALWIRE_SPACE</code>, <code>SIGNALWIRE_PROJECT_ID</code> and <code>SIGNALWIRE_API_TOKEN</code> as Worker secrets.'],
      [s.voice_ready && s.sms_ready, 'Number and your phone connected', '<a href="#/settings">Pick your number and add your cell phone in Settings.</a>'],
      [contacts.total > 0, 'Contacts imported', '<a href="#/contacts">Import a CSV of your subscribers.</a>'],
      [recs.length > 0, 'Voicemail recorded', '<a href="#/voicemails">Record or upload your voicemail drop.</a>'],
    ];
    const done = steps.filter((x) => x[0]).length;
    const tile = (n, l, href) => `<a class="card stat" ${href ? `href="${href}" style="text-decoration:none;color:inherit"` : ''}><div class="num">${n ?? 0}</div><div class="lbl">${l}</div></a>`;
    root.innerHTML = `
      <div class="page-head"><div><h1>Dashboard</h1><div class="sub">Last 24 hours</div></div></div>
      ${s.configured ? `<div class="card" id="reg-card" style="margin-bottom:14px">${regCard(ctx.registration)}</div>` : ''}
      <div class="grid cols-4" style="margin-bottom:14px">
        ${tile(st.sms_sent, 'Texts sent')}
        ${tile(st.replies, 'Replies received', '#/inbox')}
        ${tile(st.calls, 'Calls placed', '#/dialer')}
        ${tile(st.voicemails, 'Voicemails dropped')}
        ${tile(st.answered, 'Live answers')}
        ${tile(st.unread, 'Unread conversations', '#/inbox')}
        ${tile(st.queued, 'Texts waiting to send', '#/campaigns')}
        ${tile(st.contacts, 'Total contacts', '#/contacts')}
      </div>
      <div class="grid cols-2">
        ${done < steps.length ? `<div class="card"><h2>Get started (${done}/${steps.length})</h2><ul class="steps">
          ${steps.map(([ok, t, hint]) => `<li><span class="tick ${ok ? 'ok' : ''}">${ok ? '&#10003;' : ''}</span><div><strong>${t}</strong>${ok ? '' : `<div class="muted small">${hint}</div>`}</div></li>`).join('')}
        </ul></div>` : ''}
        <div class="card flush" style="${done < steps.length ? '' : 'grid-column:1/-1'}">
          <div style="padding:16px 16px 0"><h2>Recent calls</h2></div>
          ${calls.length ? `<div class="table-wrap"><table><thead><tr><th>Contact</th><th>Result</th><th>Length</th><th>When</th></tr></thead><tbody>
            ${calls.map((c) => `<tr><td>${esc(c.first_name || c.last_name ? fullName(c) : c.to_number || 'Unknown')}</td><td>${CALL_LABEL(c)}</td><td>${c.duration ? fmtDuration(c.duration) : ''}</td><td class="muted">${fmtDateTime(c.started_at)}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">No calls yet. Open the Dialer to start.</div>'}
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <h2>Stay compliant</h2>
        <p class="muted" style="margin:0">Only text people who agreed to hear from you, honour STOP replies (this app does it automatically), and keep calls inside the hours set in Settings.
        Prerecorded voicemail drops count as calls under US rules (TCPA): only use them on numbers you have the right to contact, and scrub against the Do Not Call registry yourself.</p>
      </div>`;
    const card = root.querySelector('#reg-card');
    if (card) {
      const refresh = async () => { card.innerHTML = regCard(null); card.innerHTML = regCard(await ctx.refreshRegistration()); };
      card.onclick = (e) => { if (e.target.closest('[data-act=reg-refresh]')) refresh().catch((x) => toast(x.message, 'error')); };
      if (!ctx.registration) refresh(); else ctx.refreshRegistration().then((r) => { card.innerHTML = regCard(r); });
    }
  },
};
