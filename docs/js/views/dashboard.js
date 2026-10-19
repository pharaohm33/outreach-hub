import { get } from '../api.js';
import { esc, fullName, fmtDateTime, fmtDuration } from '../util.js';

const CALL_LABEL = (c) => {
  if (c.vm_dropped) return '<span class="badge s-voicemailed">Voicemail dropped</span>';
  if (c.answered_by === 'human') return '<span class="badge green">Answered</span>';
  if (c.status === 'no-answer' || c.status === 'busy' || c.status === 'failed' || c.status === 'canceled') return '<span class="badge">No answer</span>';
  if (c.answered_by) return '<span class="badge">Machine</span>';
  return `<span class="badge">${esc(c.status)}</span>`;
};

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
  },
};
