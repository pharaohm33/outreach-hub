// Outreach Hub: Cloudflare Worker backend (single file, no dependencies).
// Holds your Twilio secrets, stores contacts/messages/calls in D1, sends the SMS queue,
// runs the voicemail-drop dialer logic and receives Twilio webhooks.
// The GitHub Pages UI talks to the /api/* routes with your APP_PASSWORD.

const AGENT = 'agent';
const MAX_AUDIO_B64 = 1_800_000; // keeps one D1 row under its 2 MB limit (~85 s of 8 kHz WAV)
const OPT_OUT = /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*[.!]*\s*$/i;
const OPT_IN = /^\s*(start|unstop|yes)\s*[.!]*\s*$/i;
const MACHINE = /^(machine_end_beep|machine_end_silence|machine_end_other|machine_start|fax)$/;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL UNIQUE, email TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new', notes TEXT NOT NULL DEFAULT '',
    sms_opt_out INTEGER NOT NULL DEFAULT 0, dnc INTEGER NOT NULL DEFAULT 0,
    call_attempts INTEGER NOT NULL DEFAULT 0, last_called_at INTEGER, last_disposition TEXT,
    last_message_at INTEGER, unread INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_msg ON contacts(last_message_at)`,
  `CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, body TEXT NOT NULL,
    audience TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'running',
    total INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER NOT NULL,
    direction TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
    twilio_sid TEXT, error TEXT, campaign_id INTEGER,
    created_at INTEGER NOT NULL, sent_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_queue ON messages(status, id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_sid ON messages(twilio_sid)`,
  `CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER, twilio_sid TEXT,
    kind TEXT NOT NULL DEFAULT 'auto', to_number TEXT, status TEXT NOT NULL DEFAULT 'initiated',
    answered_by TEXT, vm_dropped INTEGER NOT NULL DEFAULT 0, recording_id TEXT,
    duration INTEGER NOT NULL DEFAULT 0, agent_status TEXT, disposition TEXT, notes TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL, answered_at INTEGER, ended_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_calls_started ON calls(started_at)`,
  `CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, seconds REAL NOT NULL DEFAULT 0,
    data TEXT NOT NULL, created_at INTEGER NOT NULL)`,
];

const DEFAULTS = {
  from_number: '', messaging_service_sid: '',
  // 11:00-20:00 Eastern is inside 8am-9pm for every continental US time zone.
  timezone: 'America/New_York', window_start: 11, window_end: 20,
  sms_per_minute: 20, sms_footer: 'Reply STOP to opt out.', append_footer: true,
  default_recording_id: '', auto_vm: true, call_script: '', max_attempts: 3, min_hours: 24,
  public_url: '', twiml_app_sid: '', api_key_sid: '', api_key_secret: '',
};
const SETTING_TYPES = {
  from_number: 'str', messaging_service_sid: 'str', timezone: 'str', window_start: 'int', window_end: 'int',
  sms_per_minute: 'int', sms_footer: 'str', append_footer: 'bool', default_recording_id: 'str',
  auto_vm: 'bool', call_script: 'str', max_attempts: 'int', min_hours: 'int',
};
const SECRET_SETTINGS = ['api_key_secret'];

class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

/* ---------- small helpers ---------- */
const enc = (s) => new TextEncoder().encode(s);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const twiml = (inner) => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, { headers: { 'content-type': 'text/xml' } });
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const prep = (env, sql, ...b) => env.DB.prepare(sql).bind(...b);
const all = async (env, sql, ...b) => (await prep(env, sql, ...b).all()).results;
const first = (env, sql, ...b) => prep(env, sql, ...b).first();
const run = (env, sql, ...b) => prep(env, sql, ...b).run();

async function hmac(hash, key, data) {
  const k = await crypto.subtle.importKey('raw', enc(key), { name: 'HMAC', hash }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc(data));
}
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc(String(a))), crypto.subtle.digest('SHA-256', enc(String(b)))]);
  const xa = new Uint8Array(x), ya = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < xa.length; i++) d |= xa[i] ^ ya[i];
  return d === 0;
}
const randomId = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** "(415) 555-2671", "415-555-2671", "1 415 555 2671", "+44 20 7946 0958" -> E.164, or null */
function normPhone(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? '+' + digits : null;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}
const tagStr = (arr) => {
  const t = [...new Set((arr || []).map((x) => String(x).trim().toLowerCase().replace(/[^a-z0-9 _-]/g, '')).filter(Boolean))];
  return t.length ? ',' + t.join(',') + ',' : '';
};
const tagArr = (s) => (s || '').split(',').filter(Boolean);
const contactOut = (c) => ({ ...c, tags: tagArr(c.tags) });

/** Is "now" inside the allowed contact window for the configured time zone? */
function inWindow(s, now = new Date()) {
  let hour;
  try {
    hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: s.timezone, hour: 'numeric', hourCycle: 'h23' }).format(now));
  } catch {
    hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(now));
  }
  return hour >= s.window_start && hour < s.window_end;
}

/* ---------- settings ---------- */
async function getSettings(env) {
  const rows = await all(env, 'SELECT key, value FROM settings');
  const s = { ...DEFAULTS };
  for (const r of rows) { try { s[r.key] = JSON.parse(r.value); } catch { /* ignore bad row */ } }
  return s;
}
const publicSettings = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !SECRET_SETTINGS.includes(k)));
async function saveSettings(env, obj) {
  const stmts = Object.entries(obj).map(([k, v]) =>
    prep(env, 'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v)));
  if (stmts.length) await env.DB.batch(stmts);
}

/* ---------- Twilio ---------- */
function needTwilio(env) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) throw new ApiError(400, 'Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN as secrets on your Worker first.');
}
async function tw(env, method, path, params) {
  needTwilio(env);
  const init = { method, headers: { Authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`) } };
  if (params) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') body.append(k, String(v));
    init.body = body;
    init.headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}${path}`, init);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 200) }; }
  if (!r.ok) {
    if (r.status === 401) throw new ApiError(502, 'Twilio rejected the Account SID / Auth Token. Check the Worker secrets.');
    throw new ApiError(400, `Twilio: ${data.message || r.statusText}`, data.code);
  }
  return data;
}

/** Twilio signs every webhook: HMAC-SHA1 over full URL + sorted POST params, base64. */
async function validSignature(env, urlString, params, signature) {
  if (!signature || !env.TWILIO_AUTH_TOKEN) return false;
  let data = urlString;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const expected = btoa(String.fromCharCode(...new Uint8Array(await hmac('SHA-1', env.TWILIO_AUTH_TOKEN, data))));
  return safeEqual(expected, signature);
}

async function accessToken(env, s) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' };
  const payload = {
    jti: `${s.api_key_sid}-${now}`, iss: s.api_key_sid, sub: env.TWILIO_ACCOUNT_SID, iat: now, exp: now + 3600,
    grants: { identity: AGENT, voice: { incoming: { allow: true }, outgoing: { application_sid: s.twiml_app_sid } } },
  };
  const input = b64u(enc(JSON.stringify(header))) + '.' + b64u(enc(JSON.stringify(payload)));
  return input + '.' + b64u(await hmac('SHA-256', s.api_key_secret, input));
}

/* ---------- SMS sending ---------- */
async function sendOne(env, msg, contact, s, origin) {
  const params = { To: contact.phone, Body: msg.body, StatusCallback: `${origin}/twilio/sms-status` };
  if (s.messaging_service_sid) params.MessagingServiceSid = s.messaging_service_sid;
  else params.From = s.from_number;
  const now = Date.now();
  try {
    const d = await tw(env, 'POST', '/Messages.json', params);
    await env.DB.batch([
      prep(env, "UPDATE messages SET status = 'sent', twilio_sid = ?, sent_at = ?, error = NULL WHERE id = ?", d.sid, now, msg.id),
      prep(env, 'UPDATE contacts SET last_message_at = ?, updated_at = ? WHERE id = ?', now, now, contact.id),
    ]);
    return { ...msg, status: 'sent', twilio_sid: d.sid, sent_at: now };
  } catch (e) {
    const stmts = [prep(env, "UPDATE messages SET status = 'failed', error = ?, sent_at = ? WHERE id = ?", e.message, now, msg.id)];
    if (e.code === 21610) stmts.push(prep(env, 'UPDATE contacts SET sms_opt_out = 1, updated_at = ? WHERE id = ?', now, contact.id)); // recipient replied STOP
    await env.DB.batch(stmts);
    return { ...msg, status: 'failed', error: e.message };
  }
}

/** Sends up to `limit` queued campaign messages. Called every minute by the cron trigger. */
async function processQueue(env, origin, limit) {
  const s = await getSettings(env);
  if (!s.from_number && !s.messaging_service_sid) return { sent: 0, failed: 0, skipped: 'no_sender' };
  if (!inWindow(s)) return { sent: 0, failed: 0, skipped: 'outside_hours' };
  const n = Math.max(1, Math.min(Number(limit || s.sms_per_minute) || 20, 90));
  const now = Date.now();
  await env.DB.batch([
    prep(env, "UPDATE messages SET status = 'queued' WHERE status = 'sending' AND sent_at < ?", now - 300000), // recover crashed claims
    prep(env, "UPDATE messages SET status = 'cancelled' WHERE status = 'queued' AND contact_id IN (SELECT id FROM contacts WHERE sms_opt_out = 1)"),
  ]);
  const claimed = (await prep(env, `UPDATE messages SET status = 'sending', sent_at = ? WHERE status = 'queued' AND id IN (
      SELECT m.id FROM messages m JOIN contacts c ON c.id = m.contact_id
      LEFT JOIN campaigns ca ON ca.id = m.campaign_id
      WHERE m.status = 'queued' AND (ca.id IS NULL OR ca.status = 'running') ORDER BY m.id LIMIT ?)
      RETURNING id, contact_id, body`, now, n).all()).results;
  let sent = 0, failed = 0;
  if (claimed.length) {
    const phones = new Map((await all(env, `SELECT id, phone FROM contacts WHERE id IN (${claimed.map(() => '?').join(',')})`, ...claimed.map((m) => m.contact_id))).map((c) => [c.id, c.phone]));
    for (let i = 0; i < claimed.length; i += 5) {
      await Promise.all(claimed.slice(i, i + 5).map(async (m) => {
        const r = await sendOne(env, m, { id: m.contact_id, phone: phones.get(m.contact_id) }, s, origin);
        if (r.status === 'failed') failed++; else sent++;
      }));
    }
  }
  await run(env, `UPDATE campaigns SET status = 'done' WHERE status = 'running'
    AND NOT EXISTS (SELECT 1 FROM messages WHERE campaign_id = campaigns.id AND status IN ('queued', 'sending'))`);
  return { sent, failed };
}

/* ---------- dispositions ---------- */
const DISPOSITIONS = {
  no_answer: { status: 'attempted', soft: true },
  voicemail_dropped: { status: 'voicemailed', soft: true },
  interested: { status: 'interested' },
  not_interested: { status: 'not_interested' },
  callback: { status: 'callback' },
  wrong_number: { status: 'wrong_number', dnc: 1 },
  dnc: { status: 'dnc', dnc: 1 },
};
async function applyDisposition(env, call, disposition, notes) {
  const d = DISPOSITIONS[disposition];
  if (!d) throw new ApiError(400, 'Unknown disposition');
  const stmts = [prep(env, 'UPDATE calls SET disposition = ?, notes = CASE WHEN ? != \'\' THEN ? ELSE notes END WHERE id = ?', disposition, notes || '', notes || '', call.id)];
  const c = call.contact_id ? await first(env, 'SELECT status, notes FROM contacts WHERE id = ?', call.contact_id) : null;
  if (c) {
    // "no answer" / "voicemail" must not overwrite a real outcome such as interested.
    const status = d.soft && !['new', 'attempted', 'voicemailed'].includes(c.status) ? c.status : d.status;
    const noteLog = notes ? (c.notes ? c.notes + '\n' + notes : notes) : c.notes;
    stmts.push(prep(env, 'UPDATE contacts SET last_disposition = ?, status = ?, dnc = CASE WHEN ? = 1 THEN 1 ELSE dnc END, notes = ?, updated_at = ? WHERE id = ?',
      disposition, status, d.dnc ? 1 : 0, noteLog, Date.now(), call.contact_id));
  }
  await env.DB.batch(stmts);
}

/* ---------- HTTP entry ---------- */
let schemaReady;
function ensureSchema(env) {
  schemaReady ||= env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGIN || '*').split(',').map((x) => x.trim().replace(/\/$/, ''));
  if (!origin || !(allowed.includes('*') || allowed.includes(origin))) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export default {
  // Exposed only so the browser test page can reach them; Workers ignore extra properties.
  __test: { normPhone, inWindow, validSignature },

  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    let res;
    try {
      await ensureSchema(env);
      if (url.pathname.startsWith('/twilio/')) res = await twilioHook(request, env, url);
      else if (url.pathname.startsWith('/audio/')) res = await serveAudio(env, url);
      else if (url.pathname.startsWith('/api/')) res = await api(request, env, url);
      else res = json({ ok: true, service: 'outreach-hub' });
    } catch (e) {
      if (!(e instanceof ApiError)) console.error(e);
      res = json({ error: e instanceof ApiError ? e.message : 'Server error: ' + (e.message || e) }, e instanceof ApiError ? e.status : 500);
    }
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response([204, 205, 304].includes(res.status) ? null : res.body, { status: res.status, headers });
  },

  // Cron trigger (every minute): drains the SMS campaign queue.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await ensureSchema(env);
      const s = await getSettings(env);
      if (s.public_url) await processQueue(env, s.public_url);
    })());
  },
};

async function serveAudio(env, url) {
  const id = url.pathname.slice('/audio/'.length).replace(/\.\w+$/, '');
  const r = await first(env, 'SELECT mime, data FROM recordings WHERE id = ?', id);
  if (!r) return new Response('Not found', { status: 404 });
  const bin = atob(r.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, { headers: { 'content-type': r.mime, 'cache-control': 'public, max-age=3600' } });
}

/* ---------- Twilio webhooks (signature checked) ---------- */
async function twilioHook(request, env, url) {
  if (request.method !== 'POST') return new Response('POST only', { status: 405 });
  const params = {};
  for (const [k, v] of (await request.formData()).entries()) params[k] = String(v);
  if (!(await validSignature(env, request.url, params, request.headers.get('X-Twilio-Signature')))) {
    return new Response('Invalid signature', { status: 403 });
  }
  const origin = url.origin;
  const route = url.pathname.slice('/twilio/'.length);
  const callId = Number(url.searchParams.get('call')) || 0;
  const now = Date.now();

  if (route === 'sms') {
    const phone = normPhone(params.From);
    if (!phone) return twiml('');
    let c = await first(env, 'SELECT * FROM contacts WHERE phone = ?', phone);
    if (!c) {
      const r = await run(env, "INSERT INTO contacts(phone, tags, created_at, updated_at) VALUES(?, ',inbound,', ?, ?)", phone, now, now);
      c = { id: r.meta.last_row_id };
    }
    const body = params.Body || (Number(params.NumMedia) ? '[media message]' : '');
    const stmts = [
      prep(env, "INSERT INTO messages(contact_id, direction, body, status, twilio_sid, created_at) VALUES(?, 'in', ?, 'received', ?, ?)", c.id, body, params.MessageSid || null, now),
      prep(env, 'UPDATE contacts SET last_message_at = ?, unread = unread + 1, updated_at = ? WHERE id = ?', now, now, c.id),
    ];
    if (OPT_OUT.test(body)) {
      stmts.push(prep(env, 'UPDATE contacts SET sms_opt_out = 1 WHERE id = ?', c.id));
      stmts.push(prep(env, "UPDATE messages SET status = 'cancelled' WHERE contact_id = ? AND status IN ('queued', 'sending')", c.id));
    } else if (OPT_IN.test(body)) {
      stmts.push(prep(env, 'UPDATE contacts SET sms_opt_out = 0 WHERE id = ?', c.id));
    }
    await env.DB.batch(stmts);
    return twiml(''); // Twilio sends the standard STOP/HELP replies itself
  }

  if (route === 'sms-status') {
    const rank = { queued: 1, sending: 2, sent: 3, undelivered: 4, failed: 4, delivered: 5 };
    const st = params.MessageStatus;
    if (params.MessageSid && rank[st]) {
      await run(env, `UPDATE messages SET status = ?, error = ? WHERE twilio_sid = ? AND direction = 'out'
        AND status IN ('sent', 'sending', 'queued', 'undelivered', 'failed') AND (? >= CASE status WHEN 'queued' THEN 1 WHEN 'sending' THEN 2 WHEN 'sent' THEN 3 ELSE 4 END)`,
        st, params.ErrorCode ? `Error ${params.ErrorCode}` : null, params.MessageSid, rank[st]);
      if (params.ErrorCode === '21610') {
        await run(env, "UPDATE contacts SET sms_opt_out = 1 WHERE id = (SELECT contact_id FROM messages WHERE twilio_sid = ?)", params.MessageSid);
      }
    }
    return new Response(null, { status: 204 });
  }

  // The lead picked up. With machine detection on, Twilio calls this only after it decided who answered.
  if (route === 'lead-answer') {
    const call = await first(env, 'SELECT * FROM calls WHERE id = ?', callId);
    if (!call) return twiml('<Hangup/>');
    const answeredBy = params.AnsweredBy || 'unknown';
    await run(env, "UPDATE calls SET status = 'in-progress', answered_by = ?, answered_at = ? WHERE id = ?", answeredBy, now, callId);
    if (MACHINE.test(answeredBy)) {
      if (call.recording_id && answeredBy !== 'fax') {
        await run(env, 'UPDATE calls SET vm_dropped = 1 WHERE id = ?', callId);
        return twiml(`<Play>${esc(`${origin}/audio/${call.recording_id}.wav`)}</Play><Hangup/>`);
      }
      return twiml('<Hangup/>');
    }
    return twiml(`<Dial answerOnBridge="true" timeout="20" action="${esc(`${origin}/twilio/dial-action?call=${callId}`)}"><Client>${AGENT}</Client></Dial>`);
  }

  if (route === 'call-status') {
    const call = await first(env, 'SELECT * FROM calls WHERE id = ?', callId);
    if (!call) return new Response(null, { status: 204 });
    const status = params.CallStatus || 'completed';
    await run(env, 'UPDATE calls SET status = ?, duration = ?, ended_at = ?, answered_by = COALESCE(answered_by, ?) WHERE id = ?',
      status, Number(params.CallDuration) || 0, now, params.AnsweredBy || null, callId);
    if (!call.disposition) {
      if (call.vm_dropped) await applyDisposition(env, call, 'voicemail_dropped');
      else if (['no-answer', 'busy', 'failed', 'canceled'].includes(status)) await applyDisposition(env, call, 'no_answer');
      else if (call.answered_by && MACHINE.test(call.answered_by)) await applyDisposition(env, call, 'no_answer');
    }
    return new Response(null, { status: 204 });
  }

  // After <Dial> ends (agent leg finished or never connected).
  if (route === 'dial-action') {
    const call = await first(env, 'SELECT * FROM calls WHERE id = ?', callId);
    const st = params.DialCallStatus || 'completed';
    if (call) {
      if (call.kind === 'manual') {
        await run(env, 'UPDATE calls SET status = ?, agent_status = ?, duration = ?, ended_at = ? WHERE id = ?', st, st, Number(params.DialCallDuration) || 0, now, callId);
      } else {
        await run(env, 'UPDATE calls SET agent_status = ? WHERE id = ?', st, callId);
      }
    }
    return twiml(st === 'completed' ? '<Hangup/>' : '<Say>Sorry, we could not connect you. Goodbye.</Say><Hangup/>');
  }

  // Browser softphone typed a number (Device.connect). Twilio sends the TwiML App's request here.
  if (route === 'voice') {
    const to = normPhone(params.To);
    if (!to) return twiml('<Say>That number is not valid.</Say><Hangup/>');
    const s = await getSettings(env);
    const c = await first(env, 'SELECT id, dnc FROM contacts WHERE phone = ?', to);
    if (c && c.dnc) return twiml('<Say>That number is on your do not call list.</Say><Hangup/>');
    const r = await run(env, "INSERT INTO calls(contact_id, twilio_sid, kind, to_number, status, started_at) VALUES(?, ?, 'manual', ?, 'in-progress', ?)",
      c ? c.id : null, params.CallSid || null, to, now);
    return twiml(`<Dial callerId="${esc(s.from_number)}" answerOnBridge="true" action="${esc(`${origin}/twilio/dial-action?call=${r.meta.last_row_id}`)}"><Number>${esc(to)}</Number></Dial>`);
  }

  // Someone calls your Twilio number back: ring the browser softphone.
  if (route === 'inbound-call') {
    return twiml(`<Dial timeout="20"><Client>${AGENT}</Client></Dial><Say>Sorry, nobody is available right now. Please send us a text message.</Say>`);
  }

  return new Response('Unknown webhook', { status: 404 });
}

/* ---------- JSON API (password protected) ---------- */
async function api(request, env, url) {
  if (!env.APP_PASSWORD) throw new ApiError(500, 'Set the APP_PASSWORD secret on your Worker.');
  const auth = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!auth || !(await safeEqual(auth, env.APP_PASSWORD))) throw new ApiError(401, 'Wrong password');
  const m = request.method;
  const path = url.pathname.slice(4);
  const body = m === 'POST' || m === 'PUT' ? await request.json().catch(() => ({})) : {};
  for (const [method, re, fn] of ROUTES) {
    if (method !== m) continue;
    const x = re.exec(path);
    if (x) return json(await fn({ env, request, url, body, args: x.slice(1), origin: url.origin, query: Object.fromEntries(url.searchParams) }));
  }
  throw new ApiError(404, 'Not found');
}

const need = (v, msg) => { if (!v) throw new ApiError(404, msg); return v; };
const getContact = async (env, id) => need(await first(env, 'SELECT * FROM contacts WHERE id = ?', Number(id)), 'Contact not found');
const getCall = async (env, id) => need(await first(env, 'SELECT * FROM calls WHERE id = ?', Number(id)), 'Call not found');

function contactFilter(q) {
  const w = [], b = [];
  if (q.q) {
    w.push("(first_name || ' ' || last_name LIKE ? OR phone LIKE ? OR email LIKE ? OR company LIKE ?)");
    const like = `%${q.q}%`;
    b.push(like, like, like, like);
  }
  if (q.tag) { w.push('instr(tags, ?) > 0'); b.push(`,${String(q.tag).toLowerCase()},`); }
  if (q.status) { w.push('status = ?'); b.push(q.status); }
  return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', b };
}

const ROUTES = [
  ['GET', /^\/status$/, async ({ env, origin }) => {
    const s = await getSettings(env);
    if (s.public_url !== origin) { await saveSettings(env, { public_url: origin }); s.public_url = origin; }
    return {
      twilio_configured: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),
      voice_ready: !!(s.api_key_sid && s.api_key_secret && s.twiml_app_sid),
      sms_ready: !!(s.from_number || s.messaging_service_sid),
      origin, settings: publicSettings(s),
    };
  }],

  ['GET', /^\/settings$/, async ({ env }) => publicSettings(await getSettings(env))],
  ['PUT', /^\/settings$/, async ({ env, body }) => {
    const out = {};
    for (const [k, type] of Object.entries(SETTING_TYPES)) {
      if (!(k in body)) continue;
      if (type === 'int') out[k] = Math.max(0, parseInt(body[k], 10) || 0);
      else if (type === 'bool') out[k] = !!body[k];
      else out[k] = String(body[k] ?? '').trim();
    }
    if ('from_number' in out && out.from_number) out.from_number = normPhone(out.from_number) || out.from_number;
    if ('timezone' in out) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: out.timezone }); } catch { throw new ApiError(400, 'Unknown time zone'); }
    }
    if (('window_start' in out && out.window_start > 23) || ('window_end' in out && out.window_end > 24)) throw new ApiError(400, 'Hours must be 0-24');
    await saveSettings(env, out);
    return publicSettings(await getSettings(env));
  }],

  // One-click Twilio wiring: TwiML App (browser calling), API key (access tokens), number webhooks.
  ['GET', /^\/twilio\/numbers$/, async ({ env }) => {
    const d = await tw(env, 'GET', '/IncomingPhoneNumbers.json?PageSize=100');
    return (d.incoming_phone_numbers || []).map((n) => ({ sid: n.sid, phone_number: n.phone_number, name: n.friendly_name, sms: !!n.capabilities?.sms, voice: !!n.capabilities?.voice }));
  }],
  ['POST', /^\/setup$/, async ({ env, body, origin }) => {
    const phone = normPhone(body.phone_number);
    if (!body.phone_sid || !phone) throw new ApiError(400, 'Pick one of your Twilio numbers.');
    await tw(env, 'GET', '.json'); // verifies the credentials
    const s = await getSettings(env);
    const appParams = { FriendlyName: 'Outreach Hub', VoiceUrl: `${origin}/twilio/voice`, VoiceMethod: 'POST' };
    let appSid = s.twiml_app_sid;
    if (appSid) {
      try { await tw(env, 'POST', `/Applications/${appSid}.json`, appParams); } catch { appSid = ''; }
    }
    if (!appSid) appSid = (await tw(env, 'POST', '/Applications.json', appParams)).sid;
    const save = { twiml_app_sid: appSid, from_number: phone, public_url: origin };
    if (!s.api_key_sid || !s.api_key_secret) {
      const key = await tw(env, 'POST', '/Keys.json', { FriendlyName: 'Outreach Hub' });
      save.api_key_sid = key.sid;
      save.api_key_secret = key.secret;
    }
    await tw(env, 'POST', `/IncomingPhoneNumbers/${body.phone_sid}.json`, {
      SmsUrl: `${origin}/twilio/sms`, SmsMethod: 'POST', VoiceUrl: `${origin}/twilio/inbound-call`, VoiceMethod: 'POST',
    });
    await saveSettings(env, save);
    return { ok: true, from_number: phone };
  }],
  ['POST', /^\/voice\/token$/, async ({ env }) => {
    const s = await getSettings(env);
    if (!(s.api_key_sid && s.api_key_secret && s.twiml_app_sid)) throw new ApiError(400, 'Finish the Twilio setup in Settings first.');
    return { token: await accessToken(env, s), identity: AGENT };
  }],

  /* contacts */
  ['GET', /^\/contacts$/, async ({ env, query }) => {
    const f = contactFilter(query);
    const limit = Math.min(Number(query.limit) || 50, 200), offset = Number(query.offset) || 0;
    const rows = await all(env, `SELECT * FROM contacts ${f.where} ORDER BY id DESC LIMIT ? OFFSET ?`, ...f.b, limit, offset);
    const total = (await first(env, `SELECT count(*) AS n FROM contacts ${f.where}`, ...f.b)).n;
    return { contacts: rows.map(contactOut), total };
  }],
  ['GET', /^\/tags$/, async ({ env }) => {
    const set = new Set();
    for (const r of await all(env, "SELECT DISTINCT tags FROM contacts WHERE tags != ''")) tagArr(r.tags).forEach((t) => set.add(t));
    return [...set].sort();
  }],
  ['POST', /^\/contacts\/import$/, async ({ env, body }) => {
    const list = Array.isArray(body.contacts) ? body.contacts.slice(0, 250) : [];
    const extra = Array.isArray(body.tags) ? body.tags : [];
    const valid = [];
    let invalid = 0;
    for (const c of list) {
      const phone = normPhone(c.phone);
      if (phone) valid.push({ ...c, phone }); else invalid++;
    }
    const existing = new Map();
    for (let i = 0; i < valid.length; i += 90) {
      const chunk = valid.slice(i, i + 90);
      for (const r of await all(env, `SELECT * FROM contacts WHERE phone IN (${chunk.map(() => '?').join(',')})`, ...chunk.map((c) => c.phone))) existing.set(r.phone, r);
    }
    const final = new Map();
    let added = 0, updated = 0;
    for (const c of valid) {
      const cur = final.get(c.phone) || existing.get(c.phone);
      if (!cur) added++; else if (!final.has(c.phone)) updated++;
      const pick = (k) => String(c[k] ?? '').trim() || cur?.[k] || '';
      final.set(c.phone, {
        phone: c.phone, first_name: pick('first_name'), last_name: pick('last_name'), email: pick('email'), company: pick('company'),
        tags: tagStr([...tagArr(cur?.tags), ...(Array.isArray(c.tags) ? c.tags : String(c.tags || '').split(/[,;|]/)), ...extra]),
      });
    }
    const now = Date.now();
    const stmts = [...final.values()].map((c) => prep(env, `INSERT INTO contacts(phone, first_name, last_name, email, company, tags, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(phone) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name,
      email = excluded.email, company = excluded.company, tags = excluded.tags, updated_at = excluded.updated_at`,
      c.phone, c.first_name, c.last_name, c.email, c.company, c.tags, now, now));
    if (stmts.length) await env.DB.batch(stmts);
    return { added, updated, invalid };
  }],
  ['POST', /^\/contacts$/, async ({ env, body }) => {
    const phone = normPhone(body.phone);
    if (!phone) throw new ApiError(400, 'Enter a valid phone number (10 digits, or +country code).');
    if (await first(env, 'SELECT id FROM contacts WHERE phone = ?', phone)) throw new ApiError(400, 'A contact with that number already exists.');
    const now = Date.now();
    const r = await run(env, 'INSERT INTO contacts(phone, first_name, last_name, email, company, tags, notes, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
      phone, body.first_name || '', body.last_name || '', body.email || '', body.company || '', tagStr(body.tags), body.notes || '', now, now);
    return contactOut(await getContact(env, r.meta.last_row_id));
  }],
  ['POST', /^\/contacts\/bulk$/, async ({ env, body }) => {
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Boolean).slice(0, 90);
    if (!ids.length) throw new ApiError(400, 'Nothing selected');
    const marks = ids.map(() => '?').join(',');
    if (body.action === 'delete') {
      await env.DB.batch([
        prep(env, `DELETE FROM messages WHERE contact_id IN (${marks})`, ...ids),
        prep(env, `UPDATE calls SET contact_id = NULL WHERE contact_id IN (${marks})`, ...ids),
        prep(env, `DELETE FROM contacts WHERE id IN (${marks})`, ...ids),
      ]);
    } else if (body.action === 'add_tag' || body.action === 'remove_tag') {
      const tag = tagStr([body.tag]);
      if (!tag) throw new ApiError(400, 'Enter a tag');
      const t = tag.slice(1, -1);
      const rows = await all(env, `SELECT id, tags FROM contacts WHERE id IN (${marks})`, ...ids);
      const now = Date.now();
      await env.DB.batch(rows.map((r) => {
        const cur = tagArr(r.tags);
        const next = body.action === 'add_tag' ? [...cur, t] : cur.filter((x) => x !== t);
        return prep(env, 'UPDATE contacts SET tags = ?, updated_at = ? WHERE id = ?', tagStr(next), now, r.id);
      }));
    } else throw new ApiError(400, 'Unknown action');
    return { ok: true };
  }],
  ['PUT', /^\/contacts\/(\d+)$/, async ({ env, args, body }) => {
    const c = await getContact(env, args[0]);
    const sets = [], b = [];
    for (const k of ['first_name', 'last_name', 'email', 'company', 'notes', 'status']) if (k in body) { sets.push(`${k} = ?`); b.push(String(body[k] ?? '')); }
    if ('tags' in body) { sets.push('tags = ?'); b.push(tagStr(body.tags)); }
    for (const k of ['sms_opt_out', 'dnc']) if (k in body) { sets.push(`${k} = ?`); b.push(body[k] ? 1 : 0); }
    if ('phone' in body) {
      const p = normPhone(body.phone);
      if (!p) throw new ApiError(400, 'Invalid phone number');
      if (p !== c.phone && (await first(env, 'SELECT id FROM contacts WHERE phone = ?', p))) throw new ApiError(400, 'Another contact already has that number.');
      sets.push('phone = ?'); b.push(p);
    }
    if (sets.length) await run(env, `UPDATE contacts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...b, Date.now(), c.id);
    return contactOut(await getContact(env, c.id));
  }],
  ['DELETE', /^\/contacts\/(\d+)$/, async ({ env, args }) => {
    await env.DB.batch([
      prep(env, 'DELETE FROM messages WHERE contact_id = ?', Number(args[0])),
      prep(env, 'UPDATE calls SET contact_id = NULL WHERE contact_id = ?', Number(args[0])),
      prep(env, 'DELETE FROM contacts WHERE id = ?', Number(args[0])),
    ]);
    return { ok: true };
  }],

  /* inbox */
  ['GET', /^\/conversations$/, async ({ env }) => (await all(env, `SELECT c.id, c.first_name, c.last_name, c.phone, c.unread, c.sms_opt_out, c.last_message_at,
      (SELECT body FROM messages WHERE contact_id = c.id AND status != 'cancelled' ORDER BY id DESC LIMIT 1) AS last_body,
      (SELECT direction FROM messages WHERE contact_id = c.id AND status != 'cancelled' ORDER BY id DESC LIMIT 1) AS last_dir
      FROM contacts c WHERE c.last_message_at IS NOT NULL ORDER BY c.last_message_at DESC LIMIT 200`))],
  ['GET', /^\/contacts\/(\d+)\/messages$/, async ({ env, args }) => ({
    contact: contactOut(await getContact(env, args[0])),
    messages: await all(env, "SELECT * FROM messages WHERE contact_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 200", Number(args[0])).then((r) => r.reverse()),
  })],
  ['POST', /^\/contacts\/(\d+)\/read$/, async ({ env, args }) => { await run(env, 'UPDATE contacts SET unread = 0 WHERE id = ?', Number(args[0])); return { ok: true }; }],
  ['POST', /^\/contacts\/(\d+)\/messages$/, async ({ env, args, body, origin }) => {
    const c = await getContact(env, args[0]);
    const text = String(body.body || '').trim();
    if (!text) throw new ApiError(400, 'Write a message first');
    if (c.sms_opt_out) throw new ApiError(400, 'This contact opted out of texts. Sending is blocked.');
    const s = await getSettings(env);
    if (!s.from_number && !s.messaging_service_sid) throw new ApiError(400, 'Choose your Twilio number in Settings first.');
    const now = Date.now();
    const r = await run(env, "INSERT INTO messages(contact_id, direction, body, status, created_at) VALUES(?, 'out', ?, 'sending', ?)", c.id, text, now);
    const msg = await sendOne(env, { id: r.meta.last_row_id, body: text, direction: 'out', contact_id: c.id, created_at: now }, c, s, origin);
    await run(env, 'UPDATE contacts SET unread = 0 WHERE id = ?', c.id);
    return msg;
  }],

  /* campaigns */
  ['GET', /^\/campaigns$/, async ({ env }) => all(env, `SELECT ca.*,
      (SELECT count(*) FROM messages WHERE campaign_id = ca.id AND status IN ('queued', 'sending')) AS queued,
      (SELECT count(*) FROM messages WHERE campaign_id = ca.id AND status IN ('sent', 'delivered')) AS sent,
      (SELECT count(*) FROM messages WHERE campaign_id = ca.id AND status = 'delivered') AS delivered,
      (SELECT count(*) FROM messages WHERE campaign_id = ca.id AND status IN ('failed', 'undelivered')) AS failed,
      (SELECT count(DISTINCT r.contact_id) FROM messages r WHERE r.direction = 'in' AND r.contact_id IN (SELECT contact_id FROM messages WHERE campaign_id = ca.id AND sent_at IS NOT NULL) AND r.created_at >= ca.created_at) AS replies
      FROM campaigns ca ORDER BY ca.id DESC LIMIT 50`)],
  ['POST', /^\/campaigns$/, async ({ env, body }) => {
    const name = String(body.name || '').trim() || 'Campaign';
    let text = String(body.body || '').trim();
    if (!text) throw new ApiError(400, 'Write the message first');
    const s = await getSettings(env);
    if (!s.from_number && !s.messaging_service_sid) throw new ApiError(400, 'Choose your Twilio number in Settings first.');
    if (body.append_footer ?? s.append_footer) {
      if (s.sms_footer && !text.toLowerCase().includes('stop')) text += '\n' + s.sms_footer;
    }
    const f = contactFilter({ tag: body.tag, status: body.status });
    const where = (f.where ? f.where.replace(/^WHERE /, 'WHERE c.sms_opt_out = 0 AND ').replace(/\b(tags|status)\b/g, 'c.$1') : 'WHERE c.sms_opt_out = 0');
    const now = Date.now();
    const created = await run(env, 'INSERT INTO campaigns(name, body, audience, status, total, created_at) VALUES(?, ?, ?, ?, 0, ?)',
      name, text, [body.tag && `tag:${body.tag}`, body.status && `status:${body.status}`].filter(Boolean).join(' ') || 'all', 'running', now);
    const id = created.meta.last_row_id;
    const ins = await run(env, `INSERT INTO messages(contact_id, direction, body, status, campaign_id, created_at)
      SELECT c.id, 'out',
        replace(replace(replace(replace(?, '{{first_name}}', COALESCE(NULLIF(c.first_name, ''), 'there')), '{{last_name}}', c.last_name),
          '{{company}}', c.company), '{{name}}', COALESCE(NULLIF(trim(c.first_name || ' ' || c.last_name), ''), 'there')),
        'queued', ${id}, ${now} FROM contacts c ${where}`, text, ...f.b);
    const total = ins.meta.changes || 0;
    await run(env, "UPDATE campaigns SET total = ?, status = CASE WHEN ? = 0 THEN 'done' ELSE status END WHERE id = ?", total, total, id);
    return { id, total };
  }],
  ['POST', /^\/campaigns\/(\d+)\/(pause|resume|cancel)$/, async ({ env, args }) => {
    const id = Number(args[0]);
    if (args[1] === 'cancel') {
      await env.DB.batch([
        prep(env, "UPDATE messages SET status = 'cancelled' WHERE campaign_id = ? AND status = 'queued'", id),
        prep(env, "UPDATE campaigns SET status = 'cancelled' WHERE id = ?", id),
      ]);
    } else {
      await run(env, 'UPDATE campaigns SET status = ? WHERE id = ? AND status IN (\'running\', \'paused\')', args[1] === 'pause' ? 'paused' : 'running', id);
    }
    return { ok: true };
  }],
  ['POST', /^\/sms\/process$/, async ({ env, origin }) => processQueue(env, origin)],

  /* voicemail recordings */
  ['GET', /^\/recordings$/, async ({ env }) => all(env, 'SELECT id, name, mime, seconds, created_at FROM recordings ORDER BY created_at DESC')],
  ['POST', /^\/recordings$/, async ({ env, body }) => {
    const data = String(body.data || '');
    if (!data) throw new ApiError(400, 'No audio received');
    if (data.length > MAX_AUDIO_B64) throw new ApiError(400, 'That recording is too long. Keep voicemails under about 80 seconds.');
    const mime = body.mime === 'audio/mpeg' ? 'audio/mpeg' : 'audio/wav';
    const id = randomId();
    await run(env, 'INSERT INTO recordings(id, name, mime, seconds, data, created_at) VALUES(?, ?, ?, ?, ?, ?)',
      id, String(body.name || 'Voicemail').slice(0, 80), mime, Number(body.seconds) || 0, data, Date.now());
    const s = await getSettings(env);
    if (!s.default_recording_id) await saveSettings(env, { default_recording_id: id });
    return { id };
  }],
  ['DELETE', /^\/recordings\/([0-9a-f]+)$/, async ({ env, args }) => {
    await run(env, 'DELETE FROM recordings WHERE id = ?', args[0]);
    const s = await getSettings(env);
    if (s.default_recording_id === args[0]) await saveSettings(env, { default_recording_id: '' });
    return { ok: true };
  }],

  /* dialer */
  ['GET', /^\/dialer\/queue$/, async ({ env, query }) => {
    const s = await getSettings(env);
    const w = ["dnc = 0", "status NOT IN ('not_interested', 'wrong_number', 'dnc', 'interested')", 'call_attempts < ?', '(last_called_at IS NULL OR last_called_at < ?)'];
    const maxAttempts = Number(query.max_attempts) || s.max_attempts || 3;
    const minHours = query.min_hours != null && query.min_hours !== '' ? Number(query.min_hours) : s.min_hours;
    const b = [maxAttempts, Date.now() - minHours * 3600000];
    if (query.tag) { w.push('instr(tags, ?) > 0'); b.push(`,${String(query.tag).toLowerCase()},`); }
    const where = 'WHERE ' + w.join(' AND ');
    const rows = await all(env, `SELECT * FROM contacts ${where} ORDER BY (status = 'callback') DESC, call_attempts ASC, id ASC LIMIT 300`, ...b);
    const total = (await first(env, `SELECT count(*) AS n FROM contacts ${where}`, ...b)).n;
    return { contacts: rows.map(contactOut), total };
  }],
  ['POST', /^\/dialer\/call$/, async ({ env, body, origin }) => {
    const c = await getContact(env, body.contact_id);
    if (c.dnc) throw new ApiError(400, 'This number is on your do-not-call list.');
    const s = await getSettings(env);
    if (!s.from_number) throw new ApiError(400, 'Choose your Twilio number in Settings first.');
    if (!(s.api_key_sid && s.twiml_app_sid)) throw new ApiError(400, 'Finish the Twilio setup in Settings first.');
    if (!inWindow(s)) throw new ApiError(400, `Outside your calling hours (${s.window_start}:00 to ${s.window_end}:00 ${s.timezone}). Change them in Settings if needed.`);
    const recordingId = body.auto_vm ? (body.recording_id || s.default_recording_id || '') : '';
    if (body.auto_vm && !recordingId) throw new ApiError(400, 'Record or upload a voicemail first, or turn off automatic voicemail drop.');
    const now = Date.now();
    const r = await run(env, "INSERT INTO calls(contact_id, kind, to_number, status, recording_id, started_at) VALUES(?, 'auto', ?, 'initiated', ?, ?)",
      c.id, c.phone, recordingId || null, now);
    const id = r.meta.last_row_id;
    try {
      const d = await tw(env, 'POST', '/Calls.json', {
        To: c.phone, From: s.from_number,
        Url: `${origin}/twilio/lead-answer?call=${id}`, Method: 'POST',
        StatusCallback: `${origin}/twilio/call-status?call=${id}`, StatusCallbackMethod: 'POST',
        MachineDetection: 'DetectMessageEnd', MachineDetectionTimeout: 30, Timeout: 25,
      });
      await env.DB.batch([
        prep(env, 'UPDATE calls SET twilio_sid = ? WHERE id = ?', d.sid, id),
        prep(env, 'UPDATE contacts SET call_attempts = call_attempts + 1, last_called_at = ?, updated_at = ? WHERE id = ?', now, now, c.id),
      ]);
    } catch (e) {
      await run(env, "UPDATE calls SET status = 'failed', ended_at = ? WHERE id = ?", Date.now(), id);
      throw e;
    }
    return { call: await getCall(env, id), contact: contactOut(await getContact(env, c.id)) };
  }],
  ['GET', /^\/calls$/, async ({ env, query }) => all(env, `SELECT k.*, c.first_name, c.last_name FROM calls k LEFT JOIN contacts c ON c.id = k.contact_id
      ORDER BY k.id DESC LIMIT ?`, Math.min(Number(query.limit) || 100, 300))],
  ['GET', /^\/calls\/(\d+)$/, async ({ env, args }) => getCall(env, args[0])],
  ['POST', /^\/calls\/(\d+)\/disposition$/, async ({ env, args, body }) => {
    const call = await getCall(env, args[0]);
    await applyDisposition(env, call, String(body.disposition), String(body.notes || '').trim());
    return getCall(env, call.id);
  }],
  ['POST', /^\/calls\/(\d+)\/hangup$/, async ({ env, args }) => {
    const call = await getCall(env, args[0]);
    if (call.twilio_sid && !['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(call.status)) {
      try { await tw(env, 'POST', `/Calls/${call.twilio_sid}.json`, { Status: 'completed' }); } catch { /* already ended */ }
    }
    return { ok: true };
  }],
  // Live call: lead's voicemail greeting was missed by detection, play the recording now.
  ['POST', /^\/calls\/(\d+)\/voicemail$/, async ({ env, args, body, origin }) => {
    const call = await getCall(env, args[0]);
    const s = await getSettings(env);
    const rec = body.recording_id || call.recording_id || s.default_recording_id;
    if (!rec) throw new ApiError(400, 'Record or upload a voicemail first.');
    if (!call.twilio_sid || call.kind !== 'auto') throw new ApiError(400, 'Voicemail drop works on calls placed by the dialer.');
    await tw(env, 'POST', `/Calls/${call.twilio_sid}.json`, { Twiml: `<Response><Play>${esc(`${origin}/audio/${rec}.wav`)}</Play><Hangup/></Response>` });
    await run(env, 'UPDATE calls SET vm_dropped = 1, recording_id = ? WHERE id = ?', rec, call.id);
    return { ok: true };
  }],

  ['GET', /^\/stats$/, async ({ env }) => {
    const since = Date.now() - 86400000;
    return first(env, `SELECT
      (SELECT count(*) FROM contacts) AS contacts,
      (SELECT count(*) FROM contacts WHERE unread > 0) AS unread,
      (SELECT count(*) FROM messages WHERE status IN ('queued', 'sending')) AS queued,
      (SELECT count(*) FROM messages WHERE direction = 'out' AND status IN ('sent', 'delivered') AND sent_at >= ?1) AS sms_sent,
      (SELECT count(*) FROM messages WHERE direction = 'in' AND created_at >= ?1) AS replies,
      (SELECT count(*) FROM calls WHERE started_at >= ?1) AS calls,
      (SELECT count(*) FROM calls WHERE started_at >= ?1 AND answered_by = 'human') AS answered,
      (SELECT count(*) FROM calls WHERE started_at >= ?1 AND vm_dropped = 1) AS voicemails,
      (SELECT count(*) FROM contacts WHERE status = 'interested') AS interested`, since);
  }],
];
