import { get, put, post, workerUrl } from '../api.js';
import { $, esc, fmtPhone, toast, TIMEZONES } from '../util.js';

let root, ctx;

function render() {
  const st = ctx.status, s = st.settings;
  const tzs = TIMEZONES.includes(s.timezone) ? TIMEZONES : [s.timezone, ...TIMEZONES];
  const hours = (sel, max) => Array.from({ length: max + 1 }, (_, h) => `<option value="${h}" ${h === sel ? 'selected' : ''}>${h === 0 || h === 24 ? 'Midnight' : h === 12 ? 'Noon' : h < 12 ? h + ' AM' : h - 12 + ' PM'}</option>`).join('');
  root.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1></div></div>
    <div class="grid cols-2" style="align-items:start">
      <div class="grid">
        <div class="card">
          <h2>Twilio</h2>
          <ul class="steps">
            <li><span class="tick ${st.twilio_configured ? 'ok' : ''}">${st.twilio_configured ? '&#10003;' : ''}</span><div><strong>Credentials on your Worker</strong>
              <div class="muted small">${st.twilio_configured ? 'Found TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.' : 'In Cloudflare, add <code>TWILIO_ACCOUNT_SID</code> and <code>TWILIO_AUTH_TOKEN</code> as secrets on your Worker, then reload.'}</div></div></li>
            <li><span class="tick ${st.sms_ready && st.voice_ready ? 'ok' : ''}">${st.sms_ready && st.voice_ready ? '&#10003;' : ''}</span><div><strong>Phone number</strong>
              <div class="muted small">${s.from_number ? `Using ${esc(fmtPhone(s.from_number))}` : 'Pick the Twilio number to text and call from.'}</div></div></li>
          </ul>
          <div class="row" style="margin-top:8px"><button class="btn" data-act="numbers" ${st.twilio_configured ? '' : 'disabled'}>${s.from_number ? 'Change number' : 'Load my Twilio numbers'}</button></div>
          <div id="numbers" style="margin-top:12px"></div>
          <p class="muted small" style="margin:12px 0 0">Connecting a number points its texting and calling webhooks at your Worker and creates the browser-calling credentials for you. US numbers also need A2P 10DLC registration in Twilio before carriers deliver marketing texts.</p>
        </div>

        <div class="card">
          <h2>Texting</h2>
          <div class="field-row">
            <label>Texts per minute<small>Free Cloudflare plan: keep at 20 or below</small><input id="sms_per_minute" type="number" min="1" max="90" value="${s.sms_per_minute}"></label>
            <label>Messaging Service SID <small>Optional, overrides the number</small><input id="messaging_service_sid" value="${esc(s.messaging_service_sid)}" placeholder="MG..."></label>
          </div>
          <label class="inline"><input type="checkbox" id="append_footer" ${s.append_footer ? 'checked' : ''}> Add an opt-out line to campaign texts</label>
          <label style="margin-top:10px">Opt-out line<input id="sms_footer" value="${esc(s.sms_footer)}"></label>
        </div>
      </div>

      <div class="grid">
        <div class="card">
          <h2>Contact hours</h2>
          <p class="muted small">Campaign texts and dialer calls only go out inside this window. The default (11 AM to 8 PM Eastern) is within 8 AM to 9 PM for every US time zone.</p>
          <label>Time zone<select id="timezone">${tzs.map((t) => `<option ${t === s.timezone ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
          <div class="field-row"><label>From<select id="window_start">${hours(s.window_start, 23)}</select></label><label>Until<select id="window_end">${hours(s.window_end, 24)}</select></label></div>
        </div>

        <div class="card">
          <h2>Dialer</h2>
          <div class="field-row">
            <label>Max call attempts<input id="max_attempts" type="number" min="1" max="20" value="${s.max_attempts}"></label>
            <label>Wait between attempts (hours)<input id="min_hours" type="number" min="0" max="720" value="${s.min_hours}"></label>
          </div>
          <label class="inline"><input type="checkbox" id="auto_vm" ${s.auto_vm ? 'checked' : ''}> Drop my default voicemail automatically when a machine answers</label>
          <label style="margin-top:10px">Call script <small>Shown while you talk. Supports {{first_name}}, {{last_name}}, {{company}}.</small>
            <textarea id="call_script" rows="5" placeholder="Hi {{first_name}}, this is Sam from ...">${esc(s.call_script)}</textarea></label>
        </div>
      </div>
    </div>
    <div class="row" style="margin:16px 0"><button class="btn primary lg" data-act="save">Save settings</button></div>

    <div class="card">
      <h2>This browser</h2>
      <p class="muted small">Connected to <code>${esc(workerUrl())}</code>. The password is kept only in this browser.</p>
      <details><summary class="small">Webhook URLs (set automatically when you connect a number)</summary>
        <pre>Texts in:      ${esc(st.origin)}/twilio/sms
Text status:   ${esc(st.origin)}/twilio/sms-status
Browser calls: ${esc(st.origin)}/twilio/voice
Calls in:      ${esc(st.origin)}/twilio/inbound-call</pre></details>
      <div class="row" style="margin-top:10px"><button class="btn danger" data-act="signout">Sign out</button></div>
    </div>`;
}

const val = (id) => { const el = $('#' + id, root); return el.type === 'checkbox' ? el.checked : el.value; };

async function loadNumbers() {
  const box = $('#numbers', root);
  box.textContent = 'Loading…';
  const nums = await get('/twilio/numbers');
  if (!nums.length) { box.innerHTML = '<div class="alert">No phone numbers on this Twilio account yet. Buy one in the Twilio Console first.</div>'; return; }
  const cur = ctx.status.settings.from_number;
  box.innerHTML = nums.map((n) => `<label class="inline" style="display:flex;margin-bottom:8px"><input type="radio" name="num" value="${n.sid}" data-phone="${esc(n.phone_number)}" ${n.phone_number === cur ? 'checked' : ''}>
    ${esc(fmtPhone(n.phone_number))} <span class="muted small">${esc(n.name)} ${n.sms ? '' : '(no SMS)'} ${n.voice ? '' : '(no voice)'}</span></label>`).join('')
    + '<button class="btn primary" data-act="connect" style="margin-top:6px">Connect this number</button>';
}

export default {
  async mount(r, c) {
    root = r; ctx = c;
    await ctx.refreshStatus();
    render();
    root.onclick = async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      try {
        if (act === 'numbers') await loadNumbers();
        else if (act === 'connect') {
          const pick = root.querySelector('input[name=num]:checked');
          if (!pick) return toast('Pick a number', 'error');
          b.disabled = true;
          await post('/setup', { phone_sid: pick.value, phone_number: pick.dataset.phone });
          toast('Number connected. Texting and calling are ready.', 'success');
          await ctx.refreshStatus();
          render();
        } else if (act === 'save') {
          const body = {};
          for (const id of ['sms_per_minute', 'messaging_service_sid', 'append_footer', 'sms_footer', 'timezone', 'window_start', 'window_end', 'max_attempts', 'min_hours', 'auto_vm', 'call_script']) body[id] = val(id);
          ctx.status.settings = await put('/settings', body);
          toast('Settings saved', 'success');
          await ctx.refreshStatus();
        } else if (act === 'signout') ctx.signOut();
      } catch (err) { toast(err.message, 'error'); if (b) b.disabled = false; }
    };
  },
  unmount() { root.onclick = null; },
};
