// Dev harness: runs the real Worker code in the browser against an in-memory SQLite (sql.js)
// with a fake Twilio, so the whole app can be exercised without a Cloudflare or Twilio account.
// Not part of the deployed site.
import worker from '../worker/src/index.js';

export const WORKER_ORIGIN = 'https://worker.test';
export const AUTH_TOKEN = 'test_auth_token';
export const PASSWORD = 'hunter2';

export async function createBackend() {
  const SQL = await initSqlJs({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/${f}` });
  const sdb = new SQL.Database();

  class Stmt {
    constructor(sql) { this.sql = sql; this.vals = []; }
    bind(...v) { this.vals = v.map((x) => (x === undefined ? null : x)); return this; }
    _rows() {
      const st = sdb.prepare(this.sql);
      st.bind(this.vals);
      const rows = [];
      while (st.step()) rows.push(st.getAsObject());
      st.free();
      return rows;
    }
    async all() { return { results: this._rows(), meta: {} }; }
    async first() { return this._rows()[0] ?? null; }
    async run() {
      const rows = /\bRETURNING\b/i.test(this.sql) ? this._rows() : (sdb.run(this.sql, this.vals), []);
      const id = sdb.exec('SELECT last_insert_rowid()')[0].values[0][0];
      return { results: rows, meta: { changes: sdb.getRowsModified(), last_row_id: id } };
    }
  }
  const DB = {
    prepare: (sql) => new Stmt(sql),
    batch: async (stmts) => { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
  };

  const env = { DB, APP_PASSWORD: PASSWORD, TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: AUTH_TOKEN, ALLOWED_ORIGIN: '*' };
  const twilioLog = [];
  const realFetch = window.fetch.bind(window);
  let n = 1000;
  const fakeTwilio = async (url, init) => {
    const u = new URL(url);
    const params = Object.fromEntries(new URLSearchParams(init?.body || ''));
    const path = u.pathname.replace(/^\/2010-04-01\/Accounts\/ACtest/, '');
    twilioLog.push({ method: init?.method, path, params });
    const ok = (o) => new Response(JSON.stringify(o), { status: 200 });
    if (path === '.json') return ok({ sid: 'ACtest' });
    if (path === '/Messages.json') return params.To === '+15550000000' ? new Response(JSON.stringify({ code: 21610, message: 'Unsubscribed recipient' }), { status: 400 }) : ok({ sid: 'SM' + n++ });
    if (path === '/Calls.json') return ok({ sid: 'CA' + n++ });
    if (path.startsWith('/Calls/')) return ok({ sid: path.split('/')[2].replace('.json', '') });
    if (path.startsWith('/Applications')) return ok({ sid: 'APtest' });
    if (path === '/Keys.json') return ok({ sid: 'SKtest', secret: 'keysecret' });
    if (path.startsWith('/IncomingPhoneNumbers.json')) return ok({ incoming_phone_numbers: [{ sid: 'PN1', phone_number: '+14155550100', friendly_name: 'Main line', capabilities: { sms: true, voice: true } }] });
    if (path.startsWith('/IncomingPhoneNumbers/')) return ok({ sid: 'PN1' });
    return new Response(JSON.stringify({ message: 'not faked: ' + path }), { status: 404 });
  };

  window.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.origin === WORKER_ORIGIN) return worker.fetch(req, env);
    if (url.hostname === 'api.twilio.com') return fakeTwilio(req.url, { method: req.method, body: await req.text() });
    return realFetch(input, init);
  };

  // Simulate Twilio calling a webhook on the Worker (signed like the real thing).
  async function webhook(path, params) {
    const full = WORKER_ORIGIN + path;
    let data = full;
    for (const k of Object.keys(params).sort()) data += k + params[k];
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(AUTH_TOKEN), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)))));
    const res = await fetch(full, { method: 'POST', body: new URLSearchParams(params), headers: { 'X-Twilio-Signature': sig } });
    return { status: res.status, text: await res.text() };
  }

  return { env, worker, webhook, twilioLog, sdb };
}
