// ==UserScript==
// @name         Cam's VMS Console
// @namespace    sja-hamilton-d0007
// @version      0.2.0
// @description  D0007 front end for the SJA VMS portal: events and staffing, a copy-ready event schedule, roster, hours and certifications, and shift-hour approvals. Runs as whoever is signed in.
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
 * Cam Prosic - Deputy Chief Ops, SJA Hamilton D0007
 *
 * Built out of spite, mostly. National rolled out VMS, told us it was the
 * future, and gave group leads a dashboard with "Pending Approval" and
 * "Pending Publish" on it and basically nothing else. Everything I actually
 * need on a Tuesday night - whos on the Ti-Cats game saturday, are we short,
 * whose MFR cert dies next month, how many hours did someone do this year -
 * is all sitting in the database. Its just spread across six pages and five
 * seperate csv downloads and you have to click through every single one.
 *
 * I get that its a national platform with a hundred programs to serve and a
 * small team behind it. I still shouldnt have to write this. But here we are.
 *
 * Nothing clever: this reads the exact same pages and feeds the portal already
 * gives a signed in group lead and puts them on one screen. The one thing it
 * writes back is shift hour approvals (Hours tab) and that goes through the
 * portals own approval form, after you've read a list of exactly whats about
 * to change and said yes.
 *
 * If you're from another unit and want this - change GROUP_ID below and
 * you're done. Hope its useful.
 */
(function () {
  'use strict';
  // Tampermonkey sandboxes the script once you ask for a GM_ function, so the
  // real page window is unsafeWindow. window is for the bookmarklet route
  // (learned this the hard way on Safari).
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (W.D0007) return;

  // --- config ---------------------------------------------------------
  // Our group id (Hamilton-Wentworth Division = D0007). Its in the groupid=
  // param on every Group Lead page if it ever changes or you're another unit.
  const GROUP_ID = 'cf450413-327a-ed11-81ad-0022486d6297'; // HAMILTON-WENTWORTH DIVISION (D0007)
  const APP_TITLE = "Cam's VMS Console";
  const TZ = 'America/Toronto';
  const CERT_WARN_DAYS = 90;
  const SITE_ID = '24684e99-f092-4556-8b54-060fd532e73b'; // portal website id, used in the subgrid endpoint path

  // Modules register themselves here (data stuff on D, screens on TABS) so
  // adding a screen is one new file in src/ and nothing else to touch.
  const D = {};
  const TABS = [];   // { id, label, render: async () => void }

  // --- small helpers ----------------------------------------------------
  // The usual pile. toDate is the important one - VMS hands back dates in
  // three different formats depending on which page you asked.
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
