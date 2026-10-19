// Small shared helpers: escaping, formatting, toasts, modals, CSV, audio -> WAV.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function fmtPhone(p) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(p || '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p || '';
}
export const fullName = (c) => [c.first_name, c.last_name].filter(Boolean).join(' ') || fmtPhone(c.phone) || 'Unknown';
export const initials = (c) => ((c.first_name?.[0] || '') + (c.last_name?.[0] || '')).toUpperCase() || '#';

export function timeAgo(ms) {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
export const fmtDateTime = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
export const fmtDuration = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/** Fills {{first_name}} etc. the same way the Worker does. */
export function mergeFields(text, c) {
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ');
  return String(text || '')
    .replaceAll('{{first_name}}', c.first_name || 'there')
    .replaceAll('{{last_name}}', c.last_name || '')
    .replaceAll('{{company}}', c.company || '')
    .replaceAll('{{name}}', name || 'there');
}

/** Rough SMS segment count (GSM-7: 160/153 per segment, otherwise UCS-2: 70/67). */
export function smsInfo(text) {
  const gsm = /^[\n\r -~£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà€]*$/.test(text);
  const len = text.length;
  const single = gsm ? 160 : 70, multi = gsm ? 153 : 67;
  return { len, segments: len === 0 ? 0 : len <= single ? 1 : Math.ceil(len / multi), unicode: !gsm };
}

/* ---------- toast + modal ---------- */
export function toast(msg, kind = 'info') {
  const wrap = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3200);
}

/** Opens a modal. `body` is HTML. Resolves nothing; use the callbacks. Returns { el, close }. */
export function modal({ title, body, actions = [], wide = false, onOpen }) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Close">&times;</button></div>
    <div class="modal-body">${body}</div>
    <div class="modal-foot"></div></div>`;
  document.body.appendChild(back);
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  $('[data-close]', back).onclick = close;
  const foot = $('.modal-foot', back);
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = 'btn ' + (a.kind || '');
    b.textContent = a.label;
    b.onclick = async () => {
      if (a.keepOpen) return a.onClick?.(api);
      b.disabled = true;
      try { const r = await a.onClick?.(api); if (r !== false) close(); } finally { b.disabled = false; }
    };
    foot.appendChild(b);
  }
  const api = { el: back, close, $: (s) => $(s, back) };
  onOpen?.(api);
  return api;
}

export function confirmDialog(title, message, okLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title, body: `<p>${esc(message)}</p>`,
      actions: [
        { label: 'Cancel', onClick: () => { done = true; resolve(false); } },
        { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: () => { done = true; resolve(true); } },
      ],
    });
    new MutationObserver((_, o) => { if (!document.body.contains(m.el)) { o.disconnect(); if (!done) resolve(false); } }).observe(document.body, { childList: true });
  });
}

/* ---------- CSV ---------- */
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  text = text.replace(/^﻿/, '');
  const delim = (text.split('\n', 1)[0].match(/\t/g) || []).length > (text.split('\n', 1)[0].match(/,/g) || []).length ? '\t' : ',';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}
export const toCSV = (rows) => rows.map((r) => r.map((v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}).join(',')).join('\n');
export function download(name, text, mime = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- audio: anything the browser can decode -> 8 kHz mono 16-bit WAV (what phone calls use) ---------- */
export async function audioToWav(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let decoded;
  try { decoded = await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { ctx.close(); }
  const rate = 8000;
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const samples = (await off.startRendering()).getChannelData(0);
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  const gain = peak > 0 ? Math.min(4, 0.92 / peak) : 1; // bring quiet recordings up to a normal level
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const dv = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); dv.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v * gain)) * 0x7fff, true));
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { blob: new Blob([buf], { type: 'audio/wav' }), seconds: decoded.duration, base64: btoa(bin) };
}

export function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}

export const TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'America/Vancouver', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland'];

export const STATUS_LABELS = {
  new: 'New', attempted: 'Attempted', voicemailed: 'Voicemail left', contacted: 'Contacted', interested: 'Interested',
  not_interested: 'Not interested', callback: 'Call back', wrong_number: 'Wrong number', dnc: 'Do not call',
};
export const statusBadge = (s) => `<span class="badge s-${esc(s)}">${esc(STATUS_LABELS[s] || s)}</span>`;
