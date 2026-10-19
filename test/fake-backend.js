// Dev harness: runs the real Worker code in the browser against an in-memory SQLite (sql.js)
// with a fake SignalWire, so the whole app can be exercised without any account.
// Not part of the deployed site.
import worker from '../worker/src/index.js';

export const WORKER_ORIGIN = 'https://worker.test';
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

  const env = { DB, APP_PASSWORD: PASSWORD, SIGNALWIRE_SPACE: 'test', SIGNALWIRE_PROJECT_ID: 'PJtest', SIGNALWIRE_API_TOKEN: 'tok', ALLOWED_ORIGIN: '*' };
  const swLog = [];
  const realFetch = window.fetch.bind(window);
  let n = 1000;
  const fakeSignalWire = async (url, init) => {
    const u = new URL(url);
    const params = Object.fromEntries(new URLSearchParams(init?.body || ''));
    const path = u.pathname.replace(/^\/api\/laml\/2010-04-01\/Accounts\/PJtest/, '');
    const entry = { method: init?.method, path, params, sid: null };
    swLog.push(entry);
    const ok = (o, status = 200) => new Response(JSON.stringify(o), { status });
    if (path === '/Messages') {
      if (params.To === '+15550000000') return ok({ code: 21610, message: 'Unsubscribed recipient' }, 400);
      return ok({ sid: (entry.sid = 'SM' + n++) }, 201);
    }
    if (path === '/Calls') return ok({ sid: (entry.sid = 'CA' + n++), status: 'queued' }, 201);
    if (path.startsWith('/Calls/')) return ok({ sid: path.split('/')[2] });
    if (path === '/IncomingPhoneNumbers') return ok({ incoming_phone_numbers: [{ sid: 'PN1', phone_number: '+14155550100', friendly_name: 'Main line', capabilities: { sms: true, voice: true } }] });
    if (path.startsWith('/IncomingPhoneNumbers/')) return ok({ sid: 'PN1' });
    return ok({ message: 'not faked: ' + path }, 404);
  };

  window.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.origin === WORKER_ORIGIN) return worker.fetch(req, env);
    if (url.hostname === 'test.signalwire.com') return fakeSignalWire(req.url, { method: req.method, body: await req.text() });
    return realFetch(input, init);
  };

  const webhookKey = () => JSON.parse(sdb.exec("SELECT value FROM settings WHERE key = 'webhook_key'")[0].values[0][0]);

  // Simulate SignalWire calling a webhook on the Worker. `path` is like '/hook/lead-answer?call=1'.
  async function webhook(path, params, { key = true } = {}) {
    const sep = path.includes('?') ? '&' : '?';
    const full = WORKER_ORIGIN + path + (key ? `${sep}k=${key === true ? webhookKey() : key}` : '');
    const res = await fetch(full, { method: 'POST', body: new URLSearchParams(params) });
    return { status: res.status, text: await res.text() };
  }
  const lastSid = (path) => swLog.filter((l) => l.path === path && l.sid).pop()?.sid;

  return { env, worker, webhook, swLog, sdb, lastSid };
}
