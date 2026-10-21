// ==UserScript==
// @name         Cam's VMS Console
// @namespace    sja-hamilton-d0007
// @version      0.1.3
// @description  Read-only, D0007-tailored view over the SJA VMS portal (events, staffing, roster, hours, certifications) using your own signed-in session. No data is written.
// @match        https://volunteer-sja.powerappsportals.com/*
// @homepageURL  https://github.com/camprosic/vms-fix
// @supportURL   https://github.com/camprosic/vms-fix/issues
// @updateURL    https://raw.githubusercontent.com/camprosic/vms-fix/main/d0007-ops.user.js
// @downloadURL  https://raw.githubusercontent.com/camprosic/vms-fix/main/d0007-ops.user.js
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

/*
 * Cam's VMS Console
 *
 * The national VMS rollout gave group leads a dashboard that shows "Pending
 * Approval" and "Pending Publish" and not much else. Everything a unit
 * actually needs week to week - who's on Saturday's event, are we short,
 * whose certs lapse next month, who's done what this year - is in the
 * database, it's just spread across six pages and five csv downloads.
 * I'd rather this had shipped with the product. It didn't, so here we are.
 *
 * Nothing in here writes to VMS. It reads the same pages and feeds the portal
 * already serves to a signed-in group lead and puts them on one screen.
 */
(function () {
  'use strict';
  // Tampermonkey runs us in a sandbox once a GM_ function is granted; the real
  // page window is unsafeWindow. Fall back to window for the bookmarklet route.
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (W.D0007) return;

  // --- config ---------------------------------------------------------
  // Group id for Hamilton-Wentworth Division. Grab it from the groupid= param
  // on any Group Lead page if it ever changes.
  const GROUP_ID = 'cf450413-327a-ed11-81ad-0022486d6297'; // HAMILTON-WENTWORTH DIVISION (D0007)
  const APP_TITLE = "Cam's VMS Console";
  const TZ = 'America/Toronto';
  const CERT_WARN_DAYS = 90;
  const SITE_ID = '24684e99-f092-4556-8b54-060fd532e73b'; // portal website id, used in the subgrid endpoint path

  // Modules register themselves here (data modules on D, screens on TABS) so a
  // new screen is one file in src/ and nothing else has to change.
  const D = {};
  const TABS = [];   // { id, label, render: async () => void }

  // --- small helpers ----------------------------------------------------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (tag, attrs = {}, html = '') => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); } n.innerHTML = html; return n; };
  const toDate = v => {
    if (!v) return null; if (v instanceof Date) return isNaN(v) ? null : v;
    const s = String(v).trim();
    const m = /\/Date\((-?\d+)\)\//.exec(s);                       // ASP.NET "/Date(ms)/" from the grid endpoint
    const ymd = /^(\d{4})[\/-](\d{2})[\/-](\d{2})$/.exec(s);         // "2026/10/17" from the CSV feeds → local midnight
    const d = m ? new Date(+m[1]) : ymd ? new Date(+ymd[1], +ymd[2] - 1, +ymd[3]) : new Date(s);
    return isNaN(d) ? null : d;
  };
  const r2 = n => Math.round((+n || 0) * 100) / 100;
  const decodeEntities = s => { const t = document.createElement('textarea'); t.innerHTML = String(s ?? ''); return t.value; };
  const fmtDT = v => { const d = toDate(v); return d ? new Intl.DateTimeFormat('en-CA', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d) : ''; };
  const fmtD = v => { const d = toDate(v); return d ? new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric' }).format(d) : ''; };
  const fmtT = v => { const d = toDate(v); return d ? new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(d) : ''; };
  const num = v => { const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };
  const daysUntil = v => { const d = toDate(v); return d ? Math.round((d - Date.now()) / 86400000) : null; };
  const norm = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

  function parseCSV(text) {
    const rows = []; let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; if (row.some(x => x !== '')) rows.push(row); row = []; }
      else field += c;
    }
    if (field !== '' || row.length) { row.push(field); if (row.some(x => x !== '')) rows.push(row); }
    const head = (rows.shift() || []).map(h => h.trim());
    return rows.map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
  }
