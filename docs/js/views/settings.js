import { get, put, post, workerUrl } from '../api.js';
import { $, esc, fmtPhone, toast, TIMEZONES } from '../util.js';

let root, ctx;

function render() {
  const st = ctx.status, s = st.settings;
  const tzs = !s.timezone || TIMEZONES.includes(s.timezone) ? TIMEZONES : [s.timezone, ...TIMEZONES];
  const hours = (sel, max) => Array.from({ length: max + 1 }, (_, h) => `<option value="${h}" ${h === sel ? 'selected' : ''}>${h === 0 || h === 24 ? 'Midnight' : h === 12 ? 'Noon' : h < 12 ? h + ' AM' : h - 12 + ' PM'}</option>`).join('');
  root.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1></div></div>
    <div class="grid cols-2" style="align-items:start">
      <div class="grid">
        <div class="card">
          <h2>SignalWire</h2>
          <ul class="steps">
            <li><span class="tick ${st.configured ? 'ok' : ''}">${st.configured ? '&#10003;' : ''}</span><div><strong>Credentials on your Worker</strong>
              <div class="muted small">${st.configured ? 'Found SIGNALWIRE_SPACE, SIGNALWIRE_PROJECT_ID and SIGNALWIRE_API_TOKEN.' : 'In Cloudflare, add <code>SIGNALWIRE_SPACE</code>, <code>SIGNALWIRE_PROJECT_ID</code> and <code>SIGNALWIRE_API_TOKEN</code> as secrets on your Worker, then reload.'}</div></div></li>
            <li><span class="tick ${st.sms_ready && st.voice_ready ? 'ok' : ''}">${st.sms_ready && st.voice_ready ? '&#10003;' : ''}</span><div><strong>Number and your phone</strong>
              <div class="muted small">${s.from_number ? `Sending from ${esc(fmtPhone(s.from_number))}${s.agent_phone ? `, calling you at ${esc(fmtPhone(s.agent_phone))}` : ''}` : 'Pick the SignalWire number to text and call from, and give your own cell phone.'}</div></div></li>
          </ul>
          <label style="margin-top:8px">Your cell phone <small>The dialer rings this number and connects each answered lead to you there.</small>
            <input id="agent_phone" type="tel" value="${esc(s.agent_phone)}" placeholder="(415) 555-0100"></label>
          <div class="row"><button class="btn" data-act="numbers" ${st.configured ? '' : 'disabled'}>${s.from_number ? 'Change number' : 'Load my SignalWire numbers'}</button></div>
          <div id="numbers" style="margin-top:12px"></div>
          <p class="muted small" style="margin:12px 0 0">Connecting a number points its texting and calling webhooks at your Worker, replacing whatever they pointed to before. Use a number that is not in use elsewhere. US numbers also need 10DLC registration in SignalWire before carriers deliver marketing texts.</p>
        </div>

        <div class="card">
          <h2>Texting</h2>
          <div class="field-row">
            <label>Default drip: 1 text every (seconds)<small>Used when you drip a campaign. 60 = one text a minute.</small><input id="drip_seconds" type="number" min="1" max="86400" value="${s.drip_seconds || 60}"></label>
            <label>Fast send: texts per minute<small>Only when drip is off. Free Cloudflare plan: keep at 20 or below.</small><input id="sms_per_minute" type="number" min="1" max="90" value="${s.sms_per_minute}"></label>
            <label>Messaging Service SID <small>Optional, overrides the number</small><input id="messaging_service_sid" value="${esc(s.messaging_service_sid)}" placeholder="MG..."></label>
          </div>
          <label class="inline"><input type="checkbox" id="append_footer" ${s.append_footer ? 'checked' : ''}> Add an opt-out line to campaign texts</label>
          <label style="margin-top:10px">Opt-out line<input id="sms_footer" value="${esc(s.sms_footer)}"></label>
        </div>
      </div>

      <div class="grid">
        <div class="card">
          <h2>Contact hours</h2>
          <p class="muted small">Off by default: texts and calls go out at any hour. Turn it on to hold campaign texts and block dialer calls outside a window (US rules generally allow 8 AM to 9 PM in the contact's own time zone).</p>
          <label class="inline"><input type="checkbox" id="enforce_hours" ${s.enforce_hours ? 'checked' : ''}> Only text and call during these hours</label>
          <div id="hours-fields" style="margin-top:12px;${s.enforce_hours ? '' : 'opacity:.5'}">
            <label>Time zone<select id="timezone"><option value="">(not set)</option>${tzs.map((t) => `<option ${t === s.timezone ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
            <div class="field-row"><label>From<select id="window_start">${hours(s.window_start, 23)}</select></label><label>Until<select id="window_end">${hours(s.window_end, 24)}</select></label></div>
          </div>
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
        <pre>Texts in:  ${esc(st.origin)}/hook/sms?k=(secret, set for you)
Calls in:  ${esc(st.origin)}/hook/inbound-call?k=(secret, set for you)</pre></details>
      <div class="row" style="margin-top:10px"><button class="btn danger" data-act="signout">Sign out</button></div>
    </div>`;
}

const val = (id) => { const el = $('#' + id, root); return el.type === 'checkbox' ? el.checked : el.value; };

async function loadNumbers() {
  const box = $('#numbers', root);
  box.textContent = 'Loading…';
  const nums = await get('/numbers');
  if (!nums.length) { box.innerHTML = '<div class="alert">No phone numbers on this SignalWire project yet. Buy one in your SignalWire dashboard first.</div>'; return; }
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
    root.onchange = (e) => { if (e.target.id === 'enforce_hours') $('#hours-fields', root).style.opacity = e.target.checked ? '' : '.5'; };
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
          await post('/setup', { phone_sid: pick.value, phone_number: pick.dataset.phone, agent_phone: $('#agent_phone', root).value.trim() });
          toast('Number connected. Texting and calling are ready.', 'success');
          await ctx.refreshStatus();
          render();
        } else if (act === 'save') {
          const body = {};
          for (const id of ['agent_phone', 'drip_seconds', 'enforce_hours', 'sms_per_minute', 'messaging_service_sid', 'append_footer', 'sms_footer', 'timezone', 'window_start', 'window_end', 'max_attempts', 'min_hours', 'auto_vm', 'call_script']) body[id] = val(id);
          ctx.status.settings = await put('/settings', body);
          toast('Settings saved', 'success');
          await ctx.refreshStatus();
        } else if (act === 'signout') ctx.signOut();
      } catch (err) { toast(err.message, 'error'); if (b) b.disabled = false; }
    };
  },
  unmount() { root.onclick = root.onchange = null; },
};
