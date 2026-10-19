import { get, post, qs } from '../api.js';
import { $, esc, fmtPhone, fullName, initials, timeAgo, fmtDateTime, modal, toast, smsInfo } from '../util.js';

let st, root, ctx, timer, composeDraft = '';

async function loadConvs() {
  st.convs = await get('/conversations');
  renderList();
}

function renderList() {
  const el = $('#convs', root);
  if (!el) return;
  const q = st.filter.toLowerCase();
  const list = st.convs.filter((c) => !q || (fullName(c) + c.phone).toLowerCase().includes(q));
  el.innerHTML = list.length ? list.map((c) => `
    <div class="conv ${c.id === st.active ? 'active' : ''} ${c.unread ? 'unread' : ''}" data-id="${c.id}">
      <span class="avatar">${esc(initials(c))}</span>
      <div class="meta"><div class="top"><span class="name">${esc(fullName(c))}</span><span class="muted small">${timeAgo(c.last_message_at)}</span></div>
      <div class="last">${c.last_dir === 'out' ? 'You: ' : ''}${esc(c.last_body || '')}</div></div>
      ${c.unread ? `<span class="pill">${c.unread}</span>` : ''}</div>`).join('')
    : `<div class="empty">${q ? 'No matches.' : 'No conversations yet. Send a message from Contacts, or run a campaign.'}</div>`;
}

async function openThread(id, { keepScroll = false } = {}) {
  st.active = id;
  const r = await get(`/contacts/${id}/messages`);
  if (st.active !== id) return;
  const sig = (t) => (t ? t.messages.map((m) => m.id + m.status).join() + t.contact.sms_opt_out : '');
  const unchanged = keepScroll && sig(st.thread) === sig(r) && st.thread.contact.id === id;
  st.thread = r;
  if (!unchanged) renderThread(keepScroll);
  if (r.contact.unread) {
    post(`/contacts/${id}/read`).then(() => { const c = st.convs.find((x) => x.id === id); if (c) c.unread = 0; renderList(); });
  }
  renderList();
}

function statusMark(m) {
  if (m.direction !== 'out') return '';
  const map = { queued: 'Queued', sending: 'Sending', sent: 'Sent', delivered: 'Delivered', failed: 'Failed', undelivered: 'Not delivered' };
  return ` &middot; ${map[m.status] || m.status}${m.error ? ` (${esc(m.error)})` : ''}`;
}

function renderThread(keepScroll) {
  const el = $('#thread', root);
  $('.split', root).classList.toggle('has-thread', !!st.thread);
  if (!st.thread) { el.innerHTML = '<div class="empty" style="margin:auto">Select a conversation</div>'; return; }
  const { contact: c, messages } = st.thread;
  const prev = $('.msgs', el);
  const atBottom = !prev || prev.scrollHeight - prev.scrollTop - prev.clientHeight < 60;
  const draft = $('textarea', el)?.value ?? composeDraft;
  el.innerHTML = `
    <div class="thread-head">
      <button class="btn sm back" data-act="back" style="display:none">&larr;</button>
      <span class="avatar">${esc(initials(c))}</span>
      <div><strong>${esc(fullName(c))}</strong><div class="muted small">${esc(fmtPhone(c.phone))}${c.company ? ' &middot; ' + esc(c.company) : ''}</div></div>
      <span class="spacer"></span>
      ${c.sms_opt_out ? '<span class="badge red">Opted out</span>' : ''}
      <button class="btn sm" data-act="call" ${c.dnc ? 'disabled' : ''}>Call</button>
    </div>
    <div class="msgs">${messages.length ? messages.map((m) => `
      <div class="msg ${m.direction === 'out' ? 'out' : ''} ${m.status === 'failed' || m.status === 'undelivered' ? 'failed' : ''}">${esc(m.body)}
        <div class="when">${fmtDateTime(m.created_at)}${statusMark(m)}</div></div>`).join('') : '<div class="empty" style="margin:auto">No messages yet. Say hello below.</div>'}</div>
    <div class="composer">
      <div style="flex:1"><textarea id="body" rows="1" placeholder="${c.sms_opt_out ? 'This contact opted out of texts' : 'Write a message (Enter to send, Shift+Enter for a new line)'}" ${c.sms_opt_out ? 'disabled' : ''}></textarea>
        <div class="muted small" id="seg"></div></div>
      <button class="btn primary" data-act="send" ${c.sms_opt_out ? 'disabled' : ''}>Send</button>
    </div>`;
  const ta = $('#body', el);
  ta.value = draft;
  updateSeg();
  const msgs = $('.msgs', el);
  if (!keepScroll || atBottom) msgs.scrollTop = msgs.scrollHeight;
  else if (prev) msgs.scrollTop = prev.scrollTop;
  if (window.matchMedia('(max-width: 900px)').matches) $('.back', el).style.display = '';
}

function updateSeg() {
  const ta = $('#body', root);
  if (!ta) return;
  composeDraft = ta.value;
  const i = smsInfo(ta.value);
  $('#seg', root).textContent = i.len ? `${i.len} characters, ${i.segments} message part${i.segments === 1 ? '' : 's'}${i.unicode ? ' (special characters shorten each part)' : ''}` : '';
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
}

async function send() {
  const ta = $('#body', root);
  const body = ta.value.trim();
  if (!body || !st.thread) return;
  const btn = $('[data-act=send]', root);
  btn.disabled = true;
  try {
    const m = await post(`/contacts/${st.active}/messages`, { body });
    composeDraft = '';
    ta.value = '';
    updateSeg();
    if (m.status === 'failed') toast(`Not sent: ${m.error}`, 'error');
    await openThread(st.active);
    await loadConvs();
  } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
}

function newConversation() {
  const m = modal({
    title: 'New message', body: '<label>Find a contact<input id="find" placeholder="Name or phone" autofocus></label><div id="hits"></div>',
    actions: [{ label: 'Close' }],
    onOpen: (m2) => {
      let t;
      m2.$('#find').oninput = (e) => {
        clearTimeout(t);
        t = setTimeout(async () => {
          const r = await get('/contacts' + qs({ q: e.target.value, limit: 8 }));
          m2.$('#hits').innerHTML = r.contacts.map((c) => `<div class="conv" data-id="${c.id}"><span class="avatar">${esc(initials(c))}</span><div class="meta"><div class="name">${esc(fullName(c))}</div><div class="last">${esc(fmtPhone(c.phone))}</div></div></div>`).join('') || '<div class="muted">No matches</div>';
        }, 200);
      };
      m2.$('#hits').onclick = (e) => {
        const row = e.target.closest('.conv');
        if (row) { m2.close(); openThread(Number(row.dataset.id)); }
      };
    },
  });
  return m;
}

export default {
  async mount(r, c, params) {
    root = r; ctx = c;
    st = { convs: [], active: null, thread: null, filter: '' };
    composeDraft = '';
    root.innerHTML = `
      <div class="page-head"><div><h1>Inbox</h1><div class="sub">Two-way texting with your contacts</div></div><button class="btn primary" data-act="new">New message</button></div>
      <div class="card flush"><div class="split">
        <div class="conv-list"><div style="padding:10px"><input type="search" id="filter" placeholder="Search conversations"></div><div id="convs"></div></div>
        <div class="thread" id="thread"></div>
      </div></div>`;
    root.onclick = (e) => {
      const conv = e.target.closest('.conv[data-id]');
      if (conv && conv.closest('#convs')) return openThread(Number(conv.dataset.id)).catch((x) => toast(x.message, 'error'));
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'send') send();
      else if (b.dataset.act === 'new') newConversation();
      else if (b.dataset.act === 'call') ctx.go(`#/dialer?c=${st.active}`);
      else if (b.dataset.act === 'back') { st.thread = null; st.active = null; renderThread(); renderList(); }
    };
    root.oninput = (e) => {
      if (e.target.id === 'body') updateSeg();
      else if (e.target.id === 'filter') { st.filter = e.target.value; renderList(); }
    };
    root.onkeydown = (e) => {
      if (e.target.id === 'body' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    };
    renderThread();
    await loadConvs();
    const want = Number(params.get('c'));
    if (want) await openThread(want);
    timer = setInterval(async () => {
      if (document.hidden) return;
      try { await loadConvs(); if (st.active) await openThread(st.active, { keepScroll: true }); } catch { /* retry next tick */ }
    }, 8000);
  },
  unmount() { clearInterval(timer); root.onclick = root.oninput = root.onkeydown = null; },
};
