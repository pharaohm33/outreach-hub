import { get, post, put, del, qs } from '../api.js';
import { $, $$, esc, fmtPhone, fullName, initials, modal, confirmDialog, toast, parseCSV, toCSV, download, statusBadge, STATUS_LABELS } from '../util.js';

const PAGE = 50;
const FIELD_HINTS = {
  first_name: ['first name', 'first_name', 'firstname', 'first', 'fname', 'given name'],
  last_name: ['last name', 'last_name', 'lastname', 'last', 'lname', 'surname', 'family name'],
  name: ['name', 'full name', 'fullname', 'contact', 'contact name'],
  phone: ['phone', 'phone number', 'mobile', 'cell', 'cell phone', 'mobile phone', 'number', 'tel', 'telephone'],
  email: ['email', 'e-mail', 'email address'],
  company: ['company', 'organization', 'organisation', 'business', 'company name'],
  tags: ['tags', 'tag', 'labels', 'list'],
};
const FIELD_LABELS = { first_name: 'First name', last_name: 'Last name', name: 'Full name (split in two)', phone: 'Phone *', email: 'Email', company: 'Company', tags: 'Tags' };

let st, root, ctx, searchTimer;

function guessMapping(headers) {
  const map = {};
  const norm = headers.map((h) => h.trim().toLowerCase());
  for (const [field, hints] of Object.entries(FIELD_HINTS)) {
    const i = norm.findIndex((h) => hints.includes(h));
    if (i >= 0) map[field] = i;
  }
  if (map.first_name != null || map.last_name != null) delete map.name;
  return map;
}

async function load() {
  const r = await get('/contacts' + qs({ q: st.q, tag: st.tag, status: st.status, limit: PAGE, offset: st.page * PAGE }));
  st.contacts = r.contacts;
  st.total = r.total;
  renderTable();
}

function renderShell() {
  root.innerHTML = `
    <div class="page-head">
      <div><h1>Contacts</h1><div class="sub" id="count"></div></div>
      <div class="row">
        <button class="btn" data-act="export">Export CSV</button>
        <button class="btn" data-act="import">Import CSV</button>
        <button class="btn primary" data-act="add">Add contact</button>
      </div>
    </div>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search name, phone, email, company" value="${esc(st.q)}">
      <select id="tag"><option value="">All tags</option>${st.tags.map((t) => `<option ${t === st.tag ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <select id="status"><option value="">Any status</option>${Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}" ${k === st.status ? 'selected' : ''}>${v}</option>`).join('')}</select>
    </div>
    <div id="bulk" class="toolbar" hidden></div>
    <div class="card flush"><div class="table-wrap" id="table"></div></div>
    <div class="row" style="justify-content:space-between;margin-top:12px" id="pager"></div>`;
}

function renderTable() {
  $('#count', root).textContent = `${st.total.toLocaleString()} contact${st.total === 1 ? '' : 's'}`;
  const t = $('#table', root);
  if (!st.contacts.length) {
    t.innerHTML = `<div class="empty">${st.q || st.tag || st.status ? 'No contacts match these filters.' : 'No contacts yet. Import a CSV or add one.'}</div>`;
  } else {
    t.innerHTML = `<table><thead><tr>
      <th style="width:30px"><input type="checkbox" id="all" aria-label="Select all on this page"></th>
      <th>Name</th><th>Phone</th><th>Company</th><th>Tags</th><th>Status</th><th></th></tr></thead><tbody>
      ${st.contacts.map((c) => `<tr class="click" data-id="${c.id}">
        <td><input type="checkbox" class="sel" data-id="${c.id}" ${st.selected.has(c.id) ? 'checked' : ''} aria-label="Select ${esc(fullName(c))}"></td>
        <td><div class="row" style="flex-wrap:nowrap"><span class="avatar">${esc(initials(c))}</span><div><strong>${esc(fullName(c))}</strong><div class="muted small">${esc(c.email)}</div></div></div></td>
        <td style="white-space:nowrap">${esc(fmtPhone(c.phone))}</td>
        <td>${esc(c.company)}</td>
        <td>${c.tags.map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</td>
        <td>${statusBadge(c.status)} ${c.sms_opt_out ? '<span class="badge red" title="Replied STOP">No texts</span>' : ''} ${c.dnc ? '<span class="badge red">DNC</span>' : ''}</td>
        <td style="white-space:nowrap"><button class="btn sm" data-act="text" data-id="${c.id}" ${c.sms_opt_out ? 'disabled' : ''}>Text</button>
          <button class="btn sm" data-act="call" data-id="${c.id}" ${c.dnc ? 'disabled' : ''}>Call</button></td></tr>`).join('')}
      </tbody></table>`;
    const all = $('#all', t);
    all.checked = st.contacts.every((c) => st.selected.has(c.id));
    all.onchange = () => { st.contacts.forEach((c) => (all.checked ? st.selected.add(c.id) : st.selected.delete(c.id))); renderTable(); };
  }
  const pages = Math.max(1, Math.ceil(st.total / PAGE));
  $('#pager', root).innerHTML = `<span class="muted">Page ${st.page + 1} of ${pages}</span>
    <span class="row"><button class="btn sm" data-act="prev" ${st.page === 0 ? 'disabled' : ''}>Previous</button><button class="btn sm" data-act="next" ${st.page + 1 >= pages ? 'disabled' : ''}>Next</button></span>`;
  renderBulk();
}

function renderBulk() {
  const el = $('#bulk', root);
  const n = st.selected.size;
  el.hidden = !n;
  if (!n) return;
  el.innerHTML = `<strong>${n} selected</strong><button class="btn sm" data-act="bulk-tag">Add tag</button><button class="btn sm" data-act="bulk-untag">Remove tag</button>
    <button class="btn sm danger" data-act="bulk-delete">Delete</button><button class="btn sm" data-act="bulk-clear">Clear</button>
    ${n >= 90 ? '<span class="muted small">(bulk actions apply to 90 contacts at a time)</span>' : ''}`;
}

async function refreshTags() { st.tags = await get('/tags'); }

function contactForm(c = {}) {
  return `
    <div class="field-row"><label>First name<input name="first_name" value="${esc(c.first_name)}"></label><label>Last name<input name="last_name" value="${esc(c.last_name)}"></label></div>
    <div class="field-row"><label>Phone<input name="phone" value="${esc(c.phone)}" placeholder="(415) 555-0101" required></label><label>Email<input name="email" type="email" value="${esc(c.email)}"></label></div>
    <div class="field-row"><label>Company<input name="company" value="${esc(c.company)}"></label>
      ${c.id ? `<label>Status<select name="status">${Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}" ${k === c.status ? 'selected' : ''}>${v}</option>`).join('')}</select></label>` : ''}</div>
    <label>Tags <small>Comma separated, e.g. subscriber, webinar</small><input name="tags" value="${esc((c.tags || []).join(', '))}"></label>
    <label>Notes<textarea name="notes">${esc(c.notes)}</textarea></label>
    ${c.id ? `<div class="row"><label class="inline"><input type="checkbox" name="sms_opt_out" ${c.sms_opt_out ? 'checked' : ''}> Opted out of texts</label>
      <label class="inline"><input type="checkbox" name="dnc" ${c.dnc ? 'checked' : ''}> Do not call</label></div>` : ''}`;
}
function readForm(m) {
  const g = (n) => m.el.querySelector(`[name=${n}]`);
  const out = { first_name: g('first_name').value.trim(), last_name: g('last_name').value.trim(), phone: g('phone').value.trim(), email: g('email').value.trim(),
    company: g('company').value.trim(), notes: g('notes').value, tags: g('tags').value.split(',').map((x) => x.trim()).filter(Boolean) };
  if (g('status')) out.status = g('status').value;
  if (g('sms_opt_out')) { out.sms_opt_out = g('sms_opt_out').checked; out.dnc = g('dnc').checked; }
  return out;
}

function openEditor(c) {
  const isNew = !c;
  const m = modal({
    title: isNew ? 'Add contact' : fullName(c), body: contactForm(c || {}), wide: true,
    actions: [
      ...(isNew ? [] : [{ label: 'Delete', kind: 'danger', keepOpen: true, onClick: async () => {
        if (!(await confirmDialog('Delete contact?', `${fullName(c)} and their text history will be removed.`, 'Delete', true))) return;
        await del(`/contacts/${c.id}`); m.close(); toast('Contact deleted'); await refreshTags(); await load();
      } }]),
      { label: 'Cancel' },
      { label: 'Save', kind: 'primary', onClick: async () => {
        try {
          if (isNew) await post('/contacts', readForm(m)); else await put(`/contacts/${c.id}`, readForm(m));
          toast('Saved', 'success'); await refreshTags(); renderShell(); await load();
        } catch (e) { toast(e.message, 'error'); return false; }
      } },
    ],
  });
}

function openImport() {
  let parsed = null, mapping = {};
  const m = modal({
    title: 'Import contacts', wide: true,
    body: `<p class="muted">Choose a CSV with a header row. Phone numbers can be written any way (US numbers get +1 added). Existing numbers are updated, not duplicated.</p>
      <label>CSV file<input type="file" id="file" accept=".csv,.tsv,.txt,text/csv"></label>
      <div id="map" hidden></div>
      <label>Tags to add to everyone <small>Comma separated, e.g. subscribers, october-list</small><input id="itags" placeholder="subscribers"></label>
      <label class="inline" style="font-weight:500"><input type="checkbox" id="consent"> I have permission to contact these people</label>
      <div id="prog" class="muted" style="margin-top:10px"></div>`,
    actions: [
      { label: 'Cancel' },
      { label: 'Import', kind: 'primary', keepOpen: true, onClick: async () => {
        if (!parsed) return toast('Choose a file first', 'error');
        if (mapping.phone == null) return toast('Pick which column holds the phone number', 'error');
        if (!$('#consent', m.el).checked) return toast('Please confirm you have permission to contact these people', 'error');
        const tags = $('#itags', m.el).value.split(',').map((x) => x.trim()).filter(Boolean);
        const rows = parsed.slice(1);
        const cell = (r, f) => (mapping[f] != null ? (r[mapping[f]] || '').trim() : '');
        const list = rows.map((r) => {
          let first = cell(r, 'first_name'), last = cell(r, 'last_name');
          if (mapping.name != null && !first && !last) { const parts = cell(r, 'name').split(/\s+/); first = parts.shift() || ''; last = parts.join(' '); }
          return { first_name: first, last_name: last, phone: cell(r, 'phone'), email: cell(r, 'email'), company: cell(r, 'company'), tags: cell(r, 'tags') };
        });
        const total = { added: 0, updated: 0, invalid: 0 };
        const btn = m.el.querySelector('.modal-foot .primary');
        btn.disabled = true;
        try {
          for (let i = 0; i < list.length; i += 200) {
            $('#prog', m.el).textContent = `Importing ${Math.min(i + 200, list.length)} of ${list.length}…`;
            const r = await post('/contacts/import', { contacts: list.slice(i, i + 200), tags });
            total.added += r.added; total.updated += r.updated; total.invalid += r.invalid;
          }
        } catch (e) { btn.disabled = false; return toast(e.message, 'error'); }
        m.close();
        toast(`${total.added} added, ${total.updated} updated${total.invalid ? `, ${total.invalid} skipped (bad phone number)` : ''}`, 'success');
        await refreshTags(); renderShell(); await load();
      } },
    ],
  });
  $('#file', m.el).onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    parsed = parseCSV(await f.text());
    if (parsed.length < 2) { parsed = null; return toast('That file has no data rows', 'error'); }
    mapping = guessMapping(parsed[0]);
    const box = $('#map', m.el);
    box.hidden = false;
    box.innerHTML = `<p><strong>${parsed.length - 1} rows found.</strong> Match your columns:</p><div class="field-row">
      ${Object.entries(FIELD_LABELS).map(([f2, label]) => `<label>${label}<select data-f="${f2}"><option value="">(skip)</option>${parsed[0].map((h, i) => `<option value="${i}" ${mapping[f2] === i ? 'selected' : ''}>${esc(h || 'Column ' + (i + 1))}</option>`).join('')}</select></label>`).join('')}</div>
      <p class="muted small">First row: ${esc(parsed[1].join(' | ').slice(0, 160))}</p>`;
    $$('select[data-f]', box).forEach((s) => (s.onchange = () => { if (s.value === '') delete mapping[s.dataset.f]; else mapping[s.dataset.f] = Number(s.value); }));
  };
}

async function exportAll() {
  const rows = [['first_name', 'last_name', 'phone', 'email', 'company', 'tags', 'status', 'notes', 'opted_out_of_texts', 'do_not_call']];
  toast('Preparing export…');
  for (let off = 0; ; off += 200) {
    const r = await get('/contacts' + qs({ limit: 200, offset: off }));
    r.contacts.forEach((c) => rows.push([c.first_name, c.last_name, c.phone, c.email, c.company, c.tags.join(';'), c.status, c.notes, c.sms_opt_out ? 'yes' : '', c.dnc ? 'yes' : '']));
    if (off + 200 >= r.total) break;
  }
  download('contacts.csv', toCSV(rows));
}

async function onClick(e) {
  const row = e.target.closest('tr.click');
  const b = e.target.closest('[data-act]');
  if (e.target.classList.contains('sel')) {
    const id = Number(e.target.dataset.id);
    e.target.checked ? st.selected.add(id) : st.selected.delete(id);
    return renderBulk();
  }
  if (!b) {
    if (row && !e.target.closest('input')) openEditor(st.contacts.find((c) => c.id === Number(row.dataset.id)));
    return;
  }
  const act = b.dataset.act, id = Number(b.dataset.id);
  try {
    if (act === 'add') openEditor();
    else if (act === 'import') openImport();
    else if (act === 'export') await exportAll();
    else if (act === 'text') ctx.go(`#/inbox?c=${id}`);
    else if (act === 'call') ctx.go(`#/dialer?c=${id}`);
    else if (act === 'prev') { st.page--; await load(); }
    else if (act === 'next') { st.page++; await load(); }
    else if (act === 'bulk-clear') { st.selected.clear(); renderTable(); }
    else if (act === 'bulk-delete') {
      if (await confirmDialog('Delete contacts?', `${Math.min(st.selected.size, 90)} contacts and their text history will be removed.`, 'Delete', true)) {
        await post('/contacts/bulk', { ids: [...st.selected], action: 'delete' }); st.selected.clear(); await refreshTags(); await load();
      }
    } else if (act === 'bulk-tag' || act === 'bulk-untag') {
      const add = act === 'bulk-tag';
      const m = modal({ title: add ? 'Add tag' : 'Remove tag', body: '<label>Tag<input id="t" placeholder="subscribers" autofocus></label>', actions: [
        { label: 'Cancel' },
        { label: add ? 'Add' : 'Remove', kind: 'primary', onClick: async () => {
          const tag = $('#t', m.el).value.trim();
          if (!tag) { toast('Enter a tag', 'error'); return false; }
          await post('/contacts/bulk', { ids: [...st.selected], action: add ? 'add_tag' : 'remove_tag', tag });
          st.selected.clear(); await refreshTags(); renderShell(); await load();
        } },
      ] });
    }
  } catch (err) { toast(err.message, 'error'); }
}

export default {
  async mount(r, c) {
    root = r; ctx = c;
    st = { q: '', tag: '', status: '', page: 0, total: 0, contacts: [], tags: [], selected: new Set() };
    await refreshTags();
    renderShell();
    root.onclick = onClick;
    root.oninput = (e) => {
      if (e.target.id !== 'q') return;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { st.q = e.target.value.trim(); st.page = 0; load().catch((x) => toast(x.message, 'error')); }, 250);
    };
    root.onchange = (e) => {
      if (e.target.id === 'tag') st.tag = e.target.value;
      else if (e.target.id === 'status') st.status = e.target.value;
      else return;
      st.page = 0; load().catch((x) => toast(x.message, 'error'));
    };
    await load();
  },
  unmount() { clearTimeout(searchTimer); root.onclick = root.oninput = root.onchange = null; },
};
