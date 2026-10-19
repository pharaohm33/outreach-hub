import { get, post, qs } from '../api.js';
import { $, esc, fmtDateTime, mergeFields, smsInfo, confirmDialog, toast, STATUS_LABELS } from '../util.js';

let st, root, ctx, timer;

const STATUS_BADGE = { running: 'green', paused: '', done: '', cancelled: 'red' };

async function refreshAudience() {
  const tag = $('#tag', root).value, status = $('#status', root).value;
  const r = await get('/contacts' + qs({ tag, status, limit: 1 }));
  st.audience = r.total;
  st.sample = r.contacts[0] || { first_name: 'Alex', company: 'Acme' };
  renderPreview();
}

function renderPreview() {
  const ta = $('#body', root);
  if (!ta) return;
  const s = ctx.status.settings;
  const useFooter = $('#footer', root).checked;
  let text = ta.value.trim();
  if (useFooter && s.sms_footer && text && !text.toLowerCase().includes('stop')) text += '\n' + s.sms_footer;
  const info = smsInfo(mergeFields(text, st.sample || {}));
  $('#preview', root).textContent = text ? mergeFields(text, st.sample || {}) : 'Your message appears here.';
  $('#count', root).textContent = `${info.len} characters, ${info.segments} part${info.segments === 1 ? '' : 's'} per text${info.unicode ? ' (emoji or special characters)' : ''}`;
  $('#aud', root).textContent = st.audience == null ? '' : `${st.audience.toLocaleString()} contact${st.audience === 1 ? '' : 's'} match (anyone who replied STOP is skipped automatically)`;
}

async function loadList() {
  const list = await get('/campaigns');
  const el = $('#list', root);
  if (!el) return;
  el.innerHTML = list.length ? list.map((c) => {
    const pct = (n) => (c.total ? (n / c.total) * 100 : 0);
    return `<div class="card" style="margin-bottom:12px">
      <div class="row"><strong>${esc(c.name)}</strong><span class="badge ${STATUS_BADGE[c.status] ?? ''}">${esc(c.status)}</span><span class="spacer"></span><span class="muted small">${fmtDateTime(c.created_at)}</span></div>
      <div class="muted small" style="margin:4px 0 8px">Audience: ${esc(c.audience)}</div>
      <div class="progress" title="${c.sent} sent, ${c.queued} queued, ${c.failed} failed"><i style="width:${pct(c.sent)}%"></i><i class="f" style="width:${pct(c.failed)}%"></i><i class="q" style="width:${pct(c.queued)}%"></i></div>
      <div class="row small muted" style="margin-top:8px"><span>${c.total} total</span><span>${c.sent} sent</span><span>${c.delivered} delivered</span><span>${c.queued} waiting</span><span>${c.failed} failed</span><span><strong>${c.replies} replied</strong></span>
        <span class="spacer"></span>
        ${c.status === 'running' ? `<button class="btn sm" data-act="pause" data-id="${c.id}">Pause</button>` : ''}
        ${c.status === 'paused' ? `<button class="btn sm" data-act="resume" data-id="${c.id}">Resume</button>` : ''}
        ${c.status === 'running' || c.status === 'paused' ? `<button class="btn sm danger" data-act="cancel" data-id="${c.id}">Cancel</button>` : ''}</div>
      <details style="margin-top:8px"><summary class="small muted">Message</summary><div class="bubble-preview" style="margin-top:6px">${esc(c.body)}</div></details>
    </div>`;
  }).join('') : '<div class="card empty">No campaigns yet.</div>';
  const running = list.some((c) => c.status === 'running');
  clearTimeout(timer);
  timer = setTimeout(() => loadList().catch(() => {}), running ? 5000 : 20000);
}

async function launch() {
  const body = $('#body', root).value.trim();
  const tag = $('#tag', root).value, status = $('#status', root).value;
  if (!body) return toast('Write the message first', 'error');
  const s = ctx.status.settings;
  const n = st.audience ?? 0;
  if (!n) return toast('No contacts match this audience', 'error');
  const perMin = s.sms_per_minute || 20;
  const ok = await confirmDialog('Send this campaign?',
    `About ${n.toLocaleString()} text${n === 1 ? '' : 's'} will be queued and sent at roughly ${perMin} per minute between ${s.window_start}:00 and ${s.window_end}:00 (${s.timezone}). You can pause or cancel any time. Only send to people who agreed to receive texts from you.`,
    'Queue and send');
  if (!ok) return;
  const btn = $('[data-act=launch]', root);
  btn.disabled = true;
  try {
    const r = await post('/campaigns', { name: $('#name', root).value.trim() || 'Campaign', body, tag, status, append_footer: $('#footer', root).checked });
    toast(`${r.total} texts queued`, 'success');
    post('/sms/process').catch(() => {});
    $('#body', root).value = '';
    renderPreview();
    await loadList();
  } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
}

export default {
  async mount(r, c) {
    root = r; ctx = c;
    st = { audience: null, sample: null };
    const s = c.status.settings;
    const tags = await get('/tags');
    root.innerHTML = `
      <div class="page-head"><div><h1>SMS Campaigns</h1><div class="sub">Bulk texts that send in the background, even with this page closed</div></div>
        <button class="btn" data-act="process">Send next batch now</button></div>
      <div class="grid" style="grid-template-columns:minmax(300px,420px) 1fr;align-items:start">
        <div class="card">
          <h2>New campaign</h2>
          <label>Name<input id="name" placeholder="October promo"></label>
          <div class="field-row">
            <label>Tag<select id="tag"><option value="">Everyone</option>${tags.map((t) => `<option>${esc(t)}</option>`).join('')}</select></label>
            <label>Status<select id="status"><option value="">Any</option>${Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          </div>
          <div class="muted small" id="aud" style="margin:-6px 0 12px"></div>
          <label>Message<textarea id="body" rows="5" placeholder="Hi {{first_name}}, it's Sam from ..."></textarea></label>
          <div class="merge-chips">${['first_name', 'last_name', 'company', 'name'].map((f) => `<button type="button" class="chip btn-chip" data-act="chip" data-f="${f}">{{${f}}}</button>`).join('')}</div>
          <label class="inline"><input type="checkbox" id="footer" ${s.append_footer ? 'checked' : ''}> Add opt-out line: "${esc(s.sms_footer)}"</label>
          <div class="muted small" id="count" style="margin:10px 0 6px"></div>
          <div class="bubble-preview" id="preview"></div>
          <button class="btn primary" data-act="launch" style="margin-top:14px;width:100%;justify-content:center">Review and send</button>
        </div>
        <div id="list"></div>
      </div>`;
    root.onclick = async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      try {
        if (act === 'launch') await launch();
        else if (act === 'chip') {
          const ta = $('#body', root), tok = `{{${b.dataset.f}}}`;
          const i = ta.selectionStart ?? ta.value.length;
          ta.value = ta.value.slice(0, i) + tok + ta.value.slice(ta.selectionEnd ?? i);
          ta.focus(); ta.selectionStart = ta.selectionEnd = i + tok.length;
          renderPreview();
        } else if (act === 'process') {
          const r2 = await post('/sms/process');
          toast(r2.skipped ? ({ outside_hours: 'Outside your sending hours, nothing sent', no_sender: 'Choose your Twilio number in Settings first' }[r2.skipped]) : `${r2.sent} sent${r2.failed ? `, ${r2.failed} failed` : ''}`);
          await loadList();
        } else if (['pause', 'resume', 'cancel'].includes(act)) {
          if (act === 'cancel' && !(await confirmDialog('Cancel campaign?', 'Texts that have not been sent yet will be dropped.', 'Cancel campaign', true))) return;
          await post(`/campaigns/${b.dataset.id}/${act}`);
          await loadList();
        }
      } catch (err) { toast(err.message, 'error'); }
    };
    root.oninput = (e) => { if (e.target.id === 'body' || e.target.id === 'footer') renderPreview(); };
    root.onchange = (e) => { if (e.target.id === 'tag' || e.target.id === 'status') refreshAudience().catch((x) => toast(x.message, 'error')); };
    await Promise.all([refreshAudience(), loadList()]);
  },
  unmount() { clearTimeout(timer); root.onclick = root.oninput = root.onchange = null; },
};
