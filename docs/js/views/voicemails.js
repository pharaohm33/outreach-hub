import { get, post, put, del, workerUrl } from '../api.js';
import { $, esc, fmtDateTime, fmtDuration, audioToWav, confirmDialog, toast } from '../util.js';

const MAX_SECONDS = 80;
let root, ctx, st, rec;

async function load() {
  st.recs = await get('/recordings');
  const s = await get('/settings');
  ctx.status.settings = s;
  st.defaultId = s.default_recording_id;
  renderList();
}

function renderList() {
  $('#list', root).innerHTML = st.recs.length ? st.recs.map((r) => `
    <div class="card" style="margin-bottom:12px">
      <div class="row"><strong>${esc(r.name)}</strong>${r.id === st.defaultId ? '<span class="badge green">Default</span>' : ''}<span class="muted small">${fmtDuration(r.seconds)} &middot; ${fmtDateTime(r.created_at)}</span><span class="spacer"></span>
        ${r.id === st.defaultId ? '' : `<button class="btn sm" data-act="default" data-id="${r.id}">Make default</button>`}
        <button class="btn sm danger" data-act="delete" data-id="${r.id}">Delete</button></div>
      <audio controls preload="none" src="${esc(workerUrl())}/audio/${r.id}.wav" style="width:100%;margin-top:10px"></audio>
    </div>`).join('') : '<div class="card empty">No voicemails yet. Record or upload one.</div>';
}

function showDraft(draft) {
  st.draft = draft;
  const box = $('#draft', root);
  if (!draft) { box.hidden = true; return; }
  box.hidden = false;
  $('#draft-audio', root).src = URL.createObjectURL(draft.blob);
  $('#draft-info', root).textContent = `${fmtDuration(draft.seconds)} long, ${(draft.blob.size / 1024).toFixed(0)} KB`;
  if (draft.seconds > MAX_SECONDS) toast(`That is ${Math.round(draft.seconds)}s long. Keep it under ${MAX_SECONDS}s.`, 'error');
}

async function useBlob(blob) {
  try {
    showDraft(await audioToWav(blob));
  } catch (e) {
    console.error(e);
    toast('Could not read that audio. Try a WAV, MP3 or M4A file, or record again.', 'error');
  }
}

async function startRecording() {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return toast('Microphone access was blocked. Allow it in your browser, or upload a file instead.', 'error'); }
  const chunks = [];
  const mr = new MediaRecorder(stream);
  const t0 = Date.now();
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mr.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(rec?.tick);
    rec = null;
    renderRecorder();
    await useBlob(new Blob(chunks, { type: mr.mimeType }));
  };
  mr.start();
  rec = { mr, t0, tick: setInterval(() => { const s = (Date.now() - t0) / 1000; $('#timer', root) && ($('#timer', root).textContent = fmtDuration(s)); if (s >= MAX_SECONDS) mr.stop(); }, 250) };
  renderRecorder();
}

function renderRecorder() {
  $('#rec-ui', root).innerHTML = rec
    ? `<span class="rec-dot"></span> Recording <strong id="timer">0:00</strong> <button class="btn danger" data-act="stop">Stop</button>`
    : `<button class="btn primary" data-act="record">&#9679; Record</button> <span class="muted">or</span> <label class="btn" style="margin:0">Upload audio<input type="file" id="file" accept="audio/*" hidden></label>`;
}

async function save() {
  const d = st.draft;
  if (!d) return;
  if (d.seconds > MAX_SECONDS) return toast(`Keep voicemails under ${MAX_SECONDS} seconds.`, 'error');
  const btn = $('[data-act=save]', root);
  btn.disabled = true;
  try {
    await post('/recordings', { name: $('#vname', root).value.trim() || 'Voicemail', mime: 'audio/wav', data: d.base64, seconds: d.seconds });
    toast('Voicemail saved', 'success');
    $('#vname', root).value = '';
    showDraft(null);
    await load();
  } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
}

export default {
  async mount(r, c) {
    root = r; ctx = c;
    st = { recs: [], defaultId: '', draft: null };
    root.innerHTML = `
      <div class="page-head"><div><h1>Voicemails</h1><div class="sub">Pre-recorded messages the dialer plays when it reaches an answering machine</div></div></div>
      <div class="grid" style="grid-template-columns:minmax(300px,440px) 1fr;align-items:start">
        <div>
          <div class="card">
            <h2>Add a voicemail</h2>
            <div class="row" id="rec-ui"></div>
            <div id="draft" hidden style="margin-top:14px">
              <audio id="draft-audio" controls style="width:100%"></audio>
              <div class="muted small" id="draft-info" style="margin:4px 0 10px"></div>
              <label>Name<input id="vname" placeholder="October intro"></label>
              <div class="row"><button class="btn primary" data-act="save">Save voicemail</button><button class="btn" data-act="discard">Discard</button></div>
            </div>
          </div>
          <div class="card" style="margin-top:12px">
            <h2>Tips for a good drop</h2>
            <ul class="muted" style="margin:0;padding-left:18px">
              <li>Keep it 20 to 30 seconds. Say who you are, why you called, and one clear next step.</li>
              <li>Say your callback number slowly, twice.</li>
              <li>It plays the same for everyone, so skip the name. Text them afterwards to personalise.</li>
              <li>Recordings are converted to phone quality (8 kHz mono) and evened out in volume.</li>
            </ul>
          </div>
        </div>
        <div id="list"></div>
      </div>`;
    renderRecorder();
    root.onclick = async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const a = b.dataset.act;
      try {
        if (a === 'record') await startRecording();
        else if (a === 'stop') rec?.mr.stop();
        else if (a === 'save') await save();
        else if (a === 'discard') showDraft(null);
        else if (a === 'default') { await put('/settings', { default_recording_id: b.dataset.id }); await load(); }
        else if (a === 'delete') {
          if (await confirmDialog('Delete voicemail?', 'The dialer will no longer be able to play it.', 'Delete', true)) { await del(`/recordings/${b.dataset.id}`); await load(); }
        }
      } catch (err) { toast(err.message, 'error'); }
    };
    root.onchange = (e) => { if (e.target.id === 'file' && e.target.files[0]) useBlob(e.target.files[0]); };
    await load();
  },
  unmount() {
    if (rec) { rec.mr.onstop = null; try { rec.mr.stream.getTracks().forEach((t) => t.stop()); rec.mr.stop(); } catch { /* already stopped */ } clearInterval(rec.tick); rec = null; }
    root.onclick = root.onchange = null;
  },
};
