// ==UserScript==
// @name         D0007 Ops Console — VMS wrapper prototype
// @namespace    sja-hamilton-d0007
// @version      0.1.1
// @description  Read-only, D0007-tailored view over the SJA VMS portal (events, staffing, roster, hours, certifications) using your own signed-in session. No data is written.
// @match        https://volunteer-sja.powerappsportals.com/*
// @homepageURL  https://github.com/camprosic/vms-fix
// @supportURL   https://github.com/camprosic/vms-fix/issues
// @updateURL    https://raw.githubusercontent.com/camprosic/vms-fix/main/d0007-ops.user.js
// @downloadURL  https://raw.githubusercontent.com/camprosic/vms-fix/main/d0007-ops.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * D0007 Ops Console
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
  if (window.D0007) return;

  // --- config ---------------------------------------------------------
  // Group id for Hamilton-Wentworth Division. Grab it from the groupid= param
  // on any Group Lead page if it ever changes.
  const GROUP_ID = 'cf450413-327a-ed11-81ad-0022486d6297'; // HAMILTON-WENTWORTH DIVISION (D0007)
  const UNIT_LABEL = 'D0007 · Hamilton-Wentworth MFR';
  const TZ = 'America/Toronto';
  const CERT_WARN_DAYS = 90;

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

  // --- data layer -------------------------------------------------------
  // Everything below is a plain same-origin fetch using whatever session the
  // browser already has. Read-only. If VMS changes a page, fix it here.
  //
  // The web api (/_api/) would have been the clean way to do all of this and
  // it did work for about a week. Then it got cut down to a handful of columns
  // with no notice, so the script leans on the pages and feeds the portal's own
  // UI uses instead. Less elegant, but those are much less likely to vanish.
  const VMS = (() => {
    let token = null;
    const cache = new Map();
    const memo = async (key, fn) => { if (!cache.has(key)) cache.set(key, fn().catch(e => { cache.delete(key); throw e; })); return cache.get(key); };

    async function fetchOk(url, opts = {}) {
      const r = await fetch(url, { credentials: 'same-origin', ...opts });
      if (r.redirected && /signin|b2clogin|login/i.test(r.url)) throw new Error('Your VMS session has expired. Sign in to the portal, then press Refresh.');
      if (!r.ok) throw new Error(`${url.split('?')[0]} → HTTP ${r.status}`);
      return r;
    }
    const getText = url => fetchOk(url).then(r => r.text());
    const getDoc = url => getText(url).then(t => new DOMParser().parseFromString(t, 'text/html'));

    async function getToken() {
      if (token) return token;
      const html = await getText('/_layout/tokenhtml');
      const m = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/) || html.match(/value="([^"]+)"[^>]*name="__RequestVerificationToken"/);
      if (!m) throw new Error('No request token returned — are you signed in to VMS?');
      return (token = m[1]);
    }

    function gridsIn(doc) {
      return [...doc.querySelectorAll('.entity-grid')].map(g => {
        let layout = null; try { layout = JSON.parse(atob(g.getAttribute('data-view-layouts') || ''))[0]; } catch (e) { /* not a data grid */ }
        return { label: g.closest('td')?.querySelector('label')?.textContent.trim() || '', rel: g.getAttribute('data-ref-rel') || '', refId: g.getAttribute('data-ref-id') || '', getUrl: g.getAttribute('data-get-url') || '', layout };
      }).filter(g => g.layout && g.getUrl);
    }

    function flatten(rec) {
      const o = { id: rec.Id, _state: rec.StateCode, _status: rec.StatusCode };
      for (const a of rec.Attributes || []) {
        const v = a.Value;
        const isRef = v && typeof v === 'object';
        o[a.Name] = a.DisplayValue ?? a.FormattedValue ?? (isRef ? (v.Name ?? v.Id ?? '') : (v ?? ''));
        // Dates come back twice: Value is the old ASP.NET "/Date(ms)/" format and
        // DisplayValue is ISO. Keep the ISO one as the raw value.
        o[a.Name + '__raw'] = /DateTime/i.test(a.Type || '') ? (a.DisplayValue || v) : isRef ? (v.Id ?? null) : v;
      }
      return o;
    }

    async function subgridRows(grid, { pageSize = 100, maxPages = 10, sortExpression } = {}) {
      const tk = await getToken();
      const rows = [];
      for (let page = 1; page <= maxPages; page++) {
        const body = { base64SecureConfiguration: grid.layout.Base64SecureConfiguration, sortExpression: sortExpression ?? grid.layout.SortExpression ?? '', search: '', page, pageSize, filter: null, metaFilter: null, timezoneOffset: new Date().getTimezoneOffset(), customParameters: [] };
        const r = await fetchOk(grid.getUrl, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', '__RequestVerificationToken': tk, 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(body) });
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('json')) throw new Error('Grid endpoint returned a page instead of data (session or token problem).');
        const j = await r.json();
        (j.Records || []).forEach(rec => rows.push(flatten(rec)));
        if (!j.MoreRecords) break;
      }
      return rows;
    }

    // 1. Upcoming published engagements with the signed-up / minimum numbers.
    //    The portal home page computes "N volunteers still needed" per card, but
    //    there's nowhere a group lead can see that across all their events at
    //    once. That's the single most useful number in the whole system.
    //    NB: get-engagements hands back the *public* engagement opportunity id,
    //    not the event id the group lead pages use. The public table is still
    //    open on the web api, so use it to translate.
    async function publicToEventIds(publicIds) {
      const map = new Map();
      for (let i = 0; i < publicIds.length; i += 10) {
        const chunk = publicIds.slice(i, i + 10);
        const filter = chunk.map(id => `msnfp_publicengagementopportunityid eq ${id}`).join(' or ');
        try {
          const r = await fetchOk(`/_api/msnfp_publicengagementopportunities?$select=msnfp_publicengagementopportunityid,_msnfp_engagementopportunityid_value&$filter=${encodeURIComponent(filter)}`, { headers: { Accept: 'application/json' } });
          const j = await r.json();
          (j.value || []).forEach(x => map.set(x.msnfp_publicengagementopportunityid, x._msnfp_engagementopportunityid_value));
        } catch (e) { /* best effort - if this fails the staffing bars just don't show */ }
      }
      return map;
    }
    const upcomingEngagements = () => memo('upcoming', async () => {
      const t = await getText('/en-US/get-engagements/');
      const j = JSON.parse(t.trim());
      const list = j.engagements || [];
      const idMap = await publicToEventIds(list.map(e => e.OppId).filter(Boolean));
      return list.map(e => ({
        id: idMap.get(e.OppId) || e.OppId, publicId: e.OppId, title: e.Title, program: e.Program, desc: e.Desc,
        start: toDate(e.StartDateFull), end: toDate(e.EndDateFull),
        signedUp: num(e.NumVols), minimum: num(e.MinVols),
        needed: Math.max(0, num(e.MinVols) - num(e.NumVols)),
        quals: (e.Quals || []).filter(Boolean), prefs: (e.Prefs || []).filter(Boolean),
        locationType: e.LocationTypeName, location: e.LocationTitle, city: e.City,
      }));
    });

    // 2. The four event lists on the Group Lead > Events page. They're standard
    //    Power Pages subgrids, so we pull their config off the page and call the
    //    subgrid endpoint directly instead of scraping the table. There's a
    //    perfectly good JSON endpoint sitting under every grid in the portal;
    //    a documented way to use it would have saved a lot of DevTools time.
    const groupEvents = () => memo('groupEvents', async () => {
      const doc = await getDoc(`/en-US/group-lead/events/?groupid=${GROUP_ID}`);
      const grids = gridsIn(doc);
      const pick = re => grids.find(g => re.test(g.label));
      const sets = { current: pick(/current/i), upcoming: pick(/upcoming/i), past: pick(/past/i), adhoc: pick(/ad ?hoc/i) };
      const out = {};
      for (const [k, g] of Object.entries(sets)) {
        if (!g) { out[k] = []; continue; }
        let rows;
        if (k === 'past') { try { rows = await subgridRows(g, { pageSize: 100, maxPages: 2, sortExpression: 'msnfp_startingdate DESC' }); } catch (e) { rows = await subgridRows(g, { pageSize: 100, maxPages: 2 }); } }
        else rows = await subgridRows(g, { pageSize: 100, maxPages: 5 });
        out[k] = rows.map(r => ({
          id: r.msnfp_engagementopportunityid || r.id, title: r.msnfp_engagementopportunitytitle, program: r.sjavms_program,
          location: r.msnfp_location, start: toDate(r.msnfp_startingdate__raw || r.msnfp_startingdate),
          status: r.msnfp_engagementopportunitystatus, recordStatus: r.statuscode,
        }));
      }
      return out;
    });

    // 3. Per event: who has signed up (participations) and what shifts have
    //    been reported (participation schedules). Both are subgrids on the
    //    event-summary page. In the portal you open each event one at a time to
    //    see this, ten rows per page. For a unit running four or five events a
    //    weekend that's a lot of clicking to answer "who's coming".
    const eventDetail = eventId => memo('event:' + eventId, async () => {
      const doc = await getDoc(`/en-US/group-lead/event-summary/?eventid=${encodeURIComponent(eventId)}&groupid=${GROUP_ID}`);
      const grids = gridsIn(doc);
      const pGrid = grids.find(g => /msnfp_participation_engagement/i.test(g.rel));
      const sGrid = grids.find(g => /participationschedule/i.test(g.rel));
      const [p, s] = await Promise.all([pGrid ? subgridRows(pGrid) : [], sGrid ? subgridRows(sGrid) : []]);
      const val = id => doc.getElementById(id)?.value || doc.getElementById(id)?.textContent || '';
      return {
        description: val('msnfp_shortdescription'),
        participants: p.map(r => ({ name: r.msnfp_contactid, contactId: r.msnfp_contactid__raw, status: r.msnfp_status, signedUp: toDate(r.createdon__raw || r.createdon), hours: num(r.msnfp_hours), pendingHours: num(r.sjavms_totalpendinghours) }))
          .sort((a, b) => norm(a.name).localeCompare(norm(b.name))),
        shifts: s.map(r => ({ name: r.sjavms_volunteer, contactId: r.sjavms_volunteer__raw, start: toDate(r.sjavms_start__raw || r.sjavms_start), hours: num(r.sjavms_hours), status: r.msnfp_schedulestatus }))
          .sort((a, b) => (a.start?.getTime() || 0) - (b.start?.getTime() || 0) || norm(a.name).localeCompare(norm(b.name))),
      };
    });

    // 4. Roster - the csv feed behind the Download CSV button on the Volunteers page.
    const roster = () => memo('roster', async () => parseCSV(await getText(`/group-lead/volunteers-by-group-csv-feed?fetchReport=&fSearch=&groupId=${GROUP_ID}`))
      .map(r => ({ name: r['Name'], email: r['Email Address'], phone: r['Phone Number'], contactId: r['Contact ID'], status: r['Status'] }))
      .sort((a, b) => norm(a.name).localeCompare(norm(b.name))));

    // 5. Hours - csv feed behind Reports > Volunteer Hours. win is '' (12 months),
    //    '90days' or '30days'. The page itself paginates ten rows at a time with
    //    no totals, so a per-volunteer or per-event rollup means downloading the
    //    csv and doing it in Excel. Fair enough for once a year, not for every
    //    week.
    const hours = (win = '') => memo('hours:' + win, async () => parseCSV(await getText(`/group-lead/participation-reports-csv-feed?fetchReport=${encodeURIComponent(win)}&fSearch=&groupId=${GROUP_ID}`))
      .map(r => ({ name: r['Volunteer'], event: r['Volunteering Event'], completed: num(r['Total Completed Hours']), pending: num(r['Total Pending Hours']) })));

    // 6. Certifications. VMS only gives these out through the windowed reports and
    //    the report codes don't match their labels in the menu. Checked the FetchXML
    //    behind each one:
    //      last12months -> expiry in the last 12 months
    //      next90days   -> expiry in the next 90 days
    //      nextYear     -> expiry next calendar year
    //      last90days   -> effective date THIS year (not what the label says)
    //      last30days   -> effective date LAST year (ditto)
    //    Pulling all five and de-duping is the widest view we can get. Anything
    //    gained more than two years ago that expires after next year won't show.
    //    There is no "show me all current certs for my group" view anywhere in
    //    VMS, which for a first-response unit whose members can't deploy on a
    //    lapsed cert is a strange thing to leave out. I get that it's a national
    //    platform with a lot of programs to serve, but this one's table stakes.
    const CERT_WINDOWS = ['last12months', 'next90days', 'nextYear', 'last90days', 'last30days'];
    const certifications = () => memo('certs', async () => {
      const get = async (name, win) => { try { return parseCSV(await getText(`/group-lead/${name}?fetchReport=${win}&fSearch=&groupId=${GROUP_ID}`)); } catch (e) { return []; } };
      const [sja, ver] = await Promise.all([
        Promise.all(CERT_WINDOWS.map(w => get('qualifications-gained-csv-feed', w))).then(a => a.flat()),
        Promise.all(CERT_WINDOWS.map(w => get('verified-qualifications-csv-feed', w))).then(a => a.flat()),
      ]);
      const rows = [], seen = new Set();
      const add = (name, qualification, effective, expiry, source) => {
        const k = [norm(name), norm(qualification), effective, expiry].join('|'); if (!name || seen.has(k)) return; seen.add(k);
        rows.push({ name, qualification: decodeEntities(qualification), effective, expiry, source });
      };
      sja.forEach(r => add(r['Qualified Contact'], r['Qualification'], r['Effective Date'], r['Expiration Date'], 'SJA-issued'));
      ver.forEach(r => add(r['Volunteer'], r['Qualification'], r['Issue Date'], r['Expiry Date'], 'Verified'));
      return rows;
    });

    return { upcomingEngagements, groupEvents, eventDetail, roster, hours, certifications, clear: () => { cache.clear(); token = null; } };
  })();

  // --- styles -----------------------------------------------------------
  // Everything is scoped under #d0007-root so we don't fight the portal css.
  const CSS = `
#d0007-root{position:fixed;inset:0;z-index:2147483000;background:#f3f5f2;color:#1d2a1f;font:14px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;display:flex;flex-direction:column;overflow:hidden}
#d0007-root *{box-sizing:border-box}
#d0007-root a{color:#2f6b3a}
#d0007-root header{background:#1f4d2b;color:#fff;padding:10px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
#d0007-root header h1{font-size:16px;margin:0;font-weight:600;letter-spacing:.2px}
#d0007-root header .sub{opacity:.8;font-size:12px}
#d0007-root header .sp{flex:1}
#d0007-root .btn{border:1px solid #cfd8d0;background:#fff;color:#1d2a1f;border-radius:6px;padding:6px 10px;cursor:pointer;font:inherit;font-size:13px}
#d0007-root .btn:hover{background:#eef3ee}
#d0007-root header .btn{background:transparent;color:#fff;border-color:rgba(255,255,255,.35)}
#d0007-root header .btn:hover{background:rgba(255,255,255,.12)}
#d0007-root nav{display:flex;gap:4px;padding:8px 16px 0;background:#fff;border-bottom:1px solid #dfe5e0;overflow-x:auto}
#d0007-root nav button{border:0;background:none;padding:8px 12px;font:inherit;font-weight:600;color:#55675a;cursor:pointer;border-bottom:3px solid transparent;white-space:nowrap}
#d0007-root nav button.on{color:#1f4d2b;border-bottom-color:#1f4d2b}
#d0007-root main{flex:1;overflow:auto;padding:16px;-webkit-overflow-scrolling:touch}
#d0007-root .wrap{max-width:1100px;margin:0 auto}
#d0007-root .bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
#d0007-root .seg{display:inline-flex;border:1px solid #cfd8d0;border-radius:6px;overflow:hidden;background:#fff}
#d0007-root .seg button{border:0;background:none;padding:6px 10px;font:inherit;font-size:13px;cursor:pointer;color:#3a4a3d}
#d0007-root .seg button.on{background:#1f4d2b;color:#fff}
#d0007-root input[type=search]{border:1px solid #cfd8d0;border-radius:6px;padding:7px 10px;font:inherit;min-width:200px;flex:1;background:#fff}
#d0007-root .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:14px}
#d0007-root .stat{background:#fff;border:1px solid #dfe5e0;border-radius:8px;padding:10px 12px}
#d0007-root .stat b{display:block;font-size:22px;line-height:1.1;color:#1f4d2b}
#d0007-root .stat.warn b{color:#b23a2a}
#d0007-root .stat span{font-size:12px;color:#5b6b5e}
#d0007-root .card{background:#fff;border:1px solid #dfe5e0;border-radius:8px;padding:12px 14px;margin-bottom:10px}
#d0007-root .card .t{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap}
#d0007-root .card h3{margin:0;font-size:15px;flex:1 1 240px}
#d0007-root .card .when{font-weight:600;color:#1f4d2b;white-space:nowrap}
#d0007-root .meta{color:#5b6b5e;font-size:13px;margin-top:4px}
#d0007-root .pill{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11.5px;font-weight:600;background:#e8eee9;color:#2f4a35;vertical-align:middle}
#d0007-root .pill.red{background:#fbe4e0;color:#9a2b1d}
#d0007-root .pill.amber{background:#fdeccd;color:#8a5a00}
#d0007-root .pill.green{background:#dcefdf;color:#1f5a2c}
#d0007-root .pill.grey{background:#e7e9e7;color:#4f5a51}
#d0007-root .staff{margin-top:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px}
#d0007-root .track{flex:1 1 140px;height:8px;background:#e6ebe6;border-radius:999px;overflow:hidden;min-width:100px}
#d0007-root .track i{display:block;height:100%;background:#2f6b3a}
#d0007-root .track i.red{background:#c2452f}
#d0007-root .detail{margin-top:10px;border-top:1px dashed #dfe5e0;padding-top:10px}
#d0007-root table{width:100%;border-collapse:collapse;background:#fff;font-size:13px}
#d0007-root th,#d0007-root td{text-align:left;padding:7px 8px;border-bottom:1px solid #e7ebe7;vertical-align:top}
#d0007-root th{font-size:12px;color:#5b6b5e;font-weight:600;background:#f7f9f7;position:sticky;top:0;cursor:pointer;user-select:none;white-space:nowrap}
#d0007-root th.sorted:after{content:" ▾";opacity:.6}
#d0007-root th.sorted.asc:after{content:" ▴"}
#d0007-root td.n,#d0007-root th.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
#d0007-root .tbl{background:#fff;border:1px solid #dfe5e0;border-radius:8px;overflow:auto;max-height:70vh}
#d0007-root tr.row{cursor:pointer}
#d0007-root tr.row:hover td{background:#f4f8f4}
#d0007-root .muted{color:#7a877c}
#d0007-root .err{background:#fbe4e0;color:#8a2416;border:1px solid #f1c3bb;border-radius:8px;padding:10px 12px;margin-bottom:12px}
#d0007-root .load{padding:30px;text-align:center;color:#5b6b5e}
#d0007-root .load:before{content:"";display:inline-block;width:18px;height:18px;border:3px solid #cfd8d0;border-top-color:#1f4d2b;border-radius:50%;animation:d7spin .8s linear infinite;vertical-align:middle;margin-right:8px}
@keyframes d7spin{to{transform:rotate(360deg)}}
#d0007-root .two{display:grid;grid-template-columns:1fr;gap:12px}
@media(min-width:900px){#d0007-root .two{grid-template-columns:3fr 2fr}}
#d0007-root .side{background:#fff;border:1px solid #dfe5e0;border-radius:8px;padding:12px 14px;align-self:start;position:sticky;top:0}
#d0007-root .side h3{margin:0 0 6px;font-size:15px}
#d0007-root .side h4{margin:12px 0 6px;font-size:12px;color:#5b6b5e;text-transform:uppercase;letter-spacing:.4px}
#d0007-root ul.plain{list-style:none;margin:0;padding:0}
#d0007-root ul.plain li{padding:4px 0;border-bottom:1px solid #eef1ee;display:flex;justify-content:space-between;gap:10px}
#d0007-root footer{font-size:11.5px;color:#7a877c;padding:6px 16px;border-top:1px solid #dfe5e0;background:#fff}
#d0007-launch{position:fixed;right:16px;bottom:16px;z-index:2147482000;background:#1f4d2b;color:#fff;border:0;border-radius:999px;padding:10px 16px;font:600 13px -apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer}
`;

  // --- ui -------------------------------------------------------------
  const state = { tab: 'events', evSet: 'upcoming', openEvent: null, hoursWin: '', hoursBy: 'volunteer', q: '', certFilter: 'all', sort: {}, rosterSel: null };
  let root = null, main = null;

  function pill(text, cls = '') { return `<span class="pill ${cls}">${esc(text)}</span>`; }
  function statusPill(s) { const n = norm(s); const cls = /cancel|declin|reject/.test(n) ? 'red' : /pending|review|draft/.test(n) ? 'amber' : /approv|complet|publish|active|confirm/.test(n) ? 'green' : 'grey'; return pill(s || '—', cls); }
  function sortRows(rows, key, defKey, defDir = 1) {
    const s = state.sort[key] || { k: defKey, d: defDir };
    return [...rows].sort((a, b) => { const x = a[s.k], y = b[s.k]; const r = typeof x === 'number' && typeof y === 'number' ? x - y : (x instanceof Date || y instanceof Date) ? ((x?.getTime() || 0) - (y?.getTime() || 0)) : norm(x).localeCompare(norm(y)); return r * s.d; });
  }
  function th(label, key, tableKey, defKey, numeric = false) {
    const s = state.sort[tableKey] || { k: defKey, d: 1 };
    const on = s.k === key;
    return `<th class="${numeric ? 'n ' : ''}${on ? 'sorted ' + (s.d > 0 ? 'asc' : '') : ''}" data-sort="${key}" data-table="${tableKey}">${esc(label)}</th>`;
  }
  function bindSort(container, rerender) {
    container.querySelectorAll('th[data-sort]').forEach(h => h.addEventListener('click', () => { const t = h.dataset.table, k = h.dataset.sort; const cur = state.sort[t]; state.sort[t] = cur && cur.k === k ? { k, d: -cur.d } : { k, d: 1 }; rerender(); }));
  }
  const matches = (q, ...fields) => !q || fields.some(f => norm(f).includes(norm(q)));

  function render() {
    root.querySelector('nav').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
    main.innerHTML = '<div class="load">Loading…</div>';
    const fn = { events: renderEvents, roster: renderRoster, hours: renderHours, certs: renderCerts }[state.tab];
    fn().catch(e => { main.innerHTML = `<div class="wrap"><div class="err"><b>Couldn't load data.</b> ${esc(e.message || e)}</div></div>`; });
  }

  // ---- Events ----
  async function renderEvents() {
    const [ev, up] = await Promise.all([VMS.groupEvents(), VMS.upcomingEngagements().catch(() => [])]);
    const staffing = new Map(up.map(e => [e.id, e]));
    const list = ev[state.evSet] || [];
    const q = state.q;
    const rows = list.filter(e => matches(q, e.title, e.location, e.program, e.status));
    const upcomingAll = ev.upcoming || [];
    const gaps = upcomingAll.map(e => staffing.get(e.id)).filter(s => s && s.needed > 0);
    const totalNeeded = gaps.reduce((a, s) => a + s.needed, 0);
    const html = `<div class="wrap">
      <div class="stats">
        <div class="stat"><b>${upcomingAll.length}</b><span>upcoming events</span></div>
        <div class="stat ${gaps.length ? 'warn' : ''}"><b>${gaps.length}</b><span>short of minimum</span></div>
        <div class="stat ${totalNeeded ? 'warn' : ''}"><b>${totalNeeded}</b><span>volunteers still needed</span></div>
        <div class="stat"><b>${(ev.current || []).length}</b><span>in progress</span></div>
      </div>
      <div class="bar">
        <div class="seg">${['upcoming', 'current', 'past', 'adhoc'].map(k => `<button data-set="${k}" class="${state.evSet === k ? 'on' : ''}">${{ upcoming: 'Upcoming', current: 'Current', past: 'Past', adhoc: 'Ad hoc' }[k]} (${(ev[k] || []).length})</button>`).join('')}</div>
        <input type="search" placeholder="Filter events…" value="${esc(q)}">
      </div>
      ${rows.length ? '' : '<div class="card muted">No events in this list.</div>'}
      ${rows.map(e => eventCard(e, staffing.get(e.id))).join('')}
    </div>`;
    main.innerHTML = html;
    main.querySelectorAll('[data-set]').forEach(b => b.addEventListener('click', () => { state.evSet = b.dataset.set; state.openEvent = null; render(); }));
    const inp = main.querySelector('input[type=search]'); inp.addEventListener('input', () => { state.q = inp.value; renderEvents(); });
    main.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => { state.openEvent = state.openEvent === b.dataset.open ? null : b.dataset.open; renderEvents(); }));
    if (state.openEvent) loadDetail(state.openEvent);
  }
  function eventCard(e, s) {
    const open = state.openEvent === e.id;
    let staff = '';
    if (s) {
      const pct = s.minimum ? Math.min(100, Math.round(100 * s.signedUp / s.minimum)) : 100;
      staff = `<div class="staff"><span><b>${s.signedUp}</b> signed up${s.minimum ? ` · min <b>${s.minimum}</b>` : ''}</span><div class="track"><i class="${s.needed ? 'red' : ''}" style="width:${pct}%"></i></div>${s.needed ? pill(`${s.needed} still needed`, 'red') : pill('Minimum met', 'green')}</div>`;
    }
    return `<div class="card">
      <div class="t"><h3>${esc(e.title)}</h3><span class="when">${esc(fmtDT(e.start))}</span></div>
      <div class="meta">${esc(e.location || (s && s.city) || '—')}${e.program ? ' · ' + esc(e.program) : ''} ${statusPill(e.status)}</div>
      ${s && s.quals.length ? `<div class="meta">Requires: ${s.quals.map(q => pill(q, 'grey')).join(' ')}</div>` : ''}
      ${staff}
      <div class="bar" style="margin:10px 0 0"><button class="btn" data-open="${esc(e.id)}">${open ? 'Hide' : "Who's on it"}</button>
        <a class="btn" href="/en-US/group-lead/event-summary/?eventid=${esc(e.id)}&groupid=${GROUP_ID}" target="_blank" rel="noopener">Open in VMS ↗</a></div>
      ${open ? `<div class="detail" id="d7-detail-${esc(e.id)}"><div class="load">Loading sign-ups…</div></div>` : ''}
    </div>`;
  }
  async function loadDetail(id) {
    const box = main.querySelector(`#d7-detail-${CSS_ID(id)}`) || main.querySelector(`[id="d7-detail-${id}"]`);
    if (!box) return;
    try {
      const d = await VMS.eventDetail(id);
      const byStatus = {}; d.participants.forEach(p => { byStatus[p.status || '—'] = (byStatus[p.status || '—'] || 0) + 1; });
      box.innerHTML = `
        ${d.description ? `<p class="muted" style="margin:0 0 8px">${esc(d.description)}</p>` : ''}
        <div class="bar"><b>Sign-ups (${d.participants.length})</b> ${Object.entries(byStatus).map(([k, v]) => statusPill(`${k}: ${v}`)).join(' ')}</div>
        ${d.participants.length ? `<div class="tbl"><table><thead><tr><th>Volunteer</th><th>Status</th><th>Signed up</th><th class="n">Hours</th><th class="n">Pending</th></tr></thead><tbody>
          ${d.participants.map(p => `<tr><td>${esc(p.name)}</td><td>${statusPill(p.status)}</td><td>${esc(fmtD(p.signedUp))}</td><td class="n">${p.hours || ''}</td><td class="n">${p.pendingHours || ''}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="muted">Nobody has signed up yet.</div>'}
        ${d.shifts.length ? `<div class="bar" style="margin-top:12px"><b>Reported shifts (${d.shifts.length})</b></div><div class="tbl"><table><thead><tr><th>Volunteer</th><th>Start</th><th class="n">Hours</th><th>Status</th></tr></thead><tbody>
          ${d.shifts.map(s => `<tr><td>${esc(s.name)}</td><td>${esc(fmtDT(s.start))}</td><td class="n">${s.hours || ''}</td><td>${statusPill(s.status)}</td></tr>`).join('')}
        </tbody></table></div>` : ''}`;
    } catch (e) { box.innerHTML = `<div class="err">${esc(e.message || e)}</div>`; }
  }
  const CSS_ID = s => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');

  // ---- Roster ----
  async function renderRoster() {
    const roster = await VMS.roster();
    const q = state.q;
    const rows = sortRows(roster.filter(r => matches(q, r.name, r.email, r.phone, r.contactId, r.status)), 'roster', 'name');
    const active = roster.filter(r => /active/i.test(r.status)).length;
    const sel = state.rosterSel && roster.find(r => r.contactId === state.rosterSel);
    main.innerHTML = `<div class="wrap">
      <div class="stats"><div class="stat"><b>${roster.length}</b><span>members in group</span></div><div class="stat"><b>${active}</b><span>active</span></div><div class="stat"><b>${roster.length - active}</b><span>other status</span></div></div>
      <div class="bar"><input type="search" placeholder="Search name, email, phone, ID…" value="${esc(q)}"><button class="btn" id="d7-csv">Download CSV</button></div>
      <div class="two"><div class="tbl"><table><thead><tr>${th('Name', 'name', 'roster', 'name')}${th('Email', 'email', 'roster', 'name')}${th('Phone', 'phone', 'roster', 'name')}${th('Status', 'status', 'roster', 'name')}${th('ID', 'contactId', 'roster', 'name')}</tr></thead><tbody>
        ${rows.map(r => `<tr class="row" data-sel="${esc(r.contactId)}"><td>${esc(r.name)}</td><td><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></td><td><a href="tel:${esc(r.phone)}">${esc(r.phone)}</a></td><td>${statusPill(r.status)}</td><td class="muted">${esc(r.contactId)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="side" id="d7-side">${sel ? '<div class="load">Loading…</div>' : '<span class="muted">Select a member to see their hours and certifications.</span>'}</div></div>
    </div>`;
    const inp = main.querySelector('input[type=search]'); inp.addEventListener('input', () => { state.q = inp.value; renderRoster(); });
    bindSort(main, renderRoster);
    main.querySelectorAll('tr[data-sel]').forEach(tr => tr.addEventListener('click', () => { state.rosterSel = tr.dataset.sel; renderRoster(); }));
    main.querySelector('#d7-csv').addEventListener('click', () => downloadCSV('d0007-roster.csv', ['Name', 'Email', 'Phone', 'Status', 'Contact ID'], rows.map(r => [r.name, r.email, r.phone, r.status, r.contactId])));
    if (sel) memberPanel(sel);
  }
  async function memberPanel(m) {
    const side = main.querySelector('#d7-side'); if (!side) return;
    try {
      const [hrs, certs] = await Promise.all([VMS.hours(''), VMS.certifications().catch(() => [])]);
      const mine = hrs.filter(h => norm(h.name) === norm(m.name));
      const tot = r2(mine.reduce((a, h) => a + h.completed, 0)), pend = r2(mine.reduce((a, h) => a + h.pending, 0));
      const myCerts = certs.filter(c => norm(c.name) === norm(m.name)).sort((a, b) => (toDate(a.expiry)?.getTime() || 0) - (toDate(b.expiry)?.getTime() || 0));
      side.innerHTML = `<h3>${esc(m.name)}</h3><div class="muted">${esc(m.email)} · ${esc(m.phone)} · ${statusPill(m.status)}</div>
        <h4>Last 12 months</h4><div class="stats" style="margin-bottom:6px"><div class="stat"><b>${tot}</b><span>completed hrs</span></div><div class="stat"><b>${pend}</b><span>pending hrs</span></div><div class="stat"><b>${mine.length}</b><span>events</span></div></div>
        ${mine.length ? `<ul class="plain">${mine.sort((a, b) => b.completed - a.completed).slice(0, 12).map(h => `<li><span>${esc(h.event)}</span><span class="n">${h.completed}${h.pending ? ` <span class="muted">(+${h.pending} pending)</span>` : ''}</span></li>`).join('')}</ul>` : '<div class="muted">No participations in the last 12 months.</div>'}
        <h4>SJA certifications</h4>${myCerts.length ? `<ul class="plain">${myCerts.map(c => `<li><span>${esc(c.qualification)}</span><span>${certPill(c.expiry)}</span></li>`).join('')}</ul>` : '<div class="muted">None on file.</div>'}`;
    } catch (e) { side.innerHTML = `<div class="err">${esc(e.message || e)}</div>`; }
  }

  // ---- Hours ----
  async function renderHours() {
    const hrs = await VMS.hours(state.hoursWin);
    const q = state.q;
    const key = state.hoursBy === 'volunteer' ? 'name' : 'event';
    const agg = new Map();
    for (const h of hrs) { const k = h[key]; const a = agg.get(k) || { label: k, completed: 0, pending: 0, count: 0, items: new Set() }; a.completed += h.completed; a.pending += h.pending; a.count++; a.items.add(h[key === 'name' ? 'event' : 'name']); agg.set(k, a); }
    const rows = sortRows([...agg.values()].map(a => ({ ...a, n: a.items.size })).filter(a => matches(q, a.label)), 'hours', 'completed', -1);
    const totC = r2(hrs.reduce((a, h) => a + h.completed, 0)), totP = r2(hrs.reduce((a, h) => a + h.pending, 0));
    const winLabel = { '': 'Last 12 months', '90days': 'Last 90 days', '30days': 'Last 30 days' };
    main.innerHTML = `<div class="wrap">
      <div class="stats"><div class="stat"><b>${totC}</b><span>completed hours</span></div><div class="stat ${totP ? 'warn' : ''}"><b>${totP}</b><span>pending approval</span></div><div class="stat"><b>${new Set(hrs.map(h => h.name)).size}</b><span>volunteers active</span></div><div class="stat"><b>${new Set(hrs.map(h => h.event)).size}</b><span>events</span></div></div>
      <div class="bar">
        <div class="seg">${['', '90days', '30days'].map(w => `<button data-win="${w}" class="${state.hoursWin === w ? 'on' : ''}">${winLabel[w]}</button>`).join('')}</div>
        <div class="seg"><button data-by="volunteer" class="${state.hoursBy === 'volunteer' ? 'on' : ''}">By volunteer</button><button data-by="event" class="${state.hoursBy === 'event' ? 'on' : ''}">By event</button></div>
        <input type="search" placeholder="Filter…" value="${esc(q)}"><button class="btn" id="d7-csv">Download CSV</button>
      </div>
      <div class="tbl"><table><thead><tr>${th(state.hoursBy === 'volunteer' ? 'Volunteer' : 'Event', 'label', 'hours', 'completed')}${th(state.hoursBy === 'volunteer' ? 'Events' : 'Volunteers', 'n', 'hours', 'completed', true)}${th('Completed hrs', 'completed', 'hours', 'completed', true)}${th('Pending hrs', 'pending', 'hours', 'completed', true)}</tr></thead><tbody>
        ${rows.map(r => `<tr><td>${esc(r.label)}</td><td class="n">${r.n}</td><td class="n"><b>${r2(r.completed)}</b></td><td class="n">${r.pending ? pill(r2(r.pending), 'amber') : '<span class="muted">0</span>'}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted" style="font-size:12px">Source: Group Lead → Reports → Volunteer Hours (approved participations, ${winLabel[state.hoursWin].toLowerCase()}).</p>
    </div>`;
    main.querySelectorAll('[data-win]').forEach(b => b.addEventListener('click', () => { state.hoursWin = b.dataset.win; render(); }));
    main.querySelectorAll('[data-by]').forEach(b => b.addEventListener('click', () => { state.hoursBy = b.dataset.by; renderHours(); }));
    const inp = main.querySelector('input[type=search]'); inp.addEventListener('input', () => { state.q = inp.value; renderHours(); });
    bindSort(main, renderHours);
    main.querySelector('#d7-csv').addEventListener('click', () => downloadCSV(`d0007-hours-${state.hoursBy}.csv`, [state.hoursBy === 'volunteer' ? 'Volunteer' : 'Event', 'Count', 'Completed hours', 'Pending hours'], rows.map(r => [r.label, r.n, r2(r.completed), r2(r.pending)])));
  }

  // ---- Certifications ----
  function certState(expiry) { if (!expiry) return 'none'; const d = daysUntil(expiry); if (d === null) return 'none'; return d < 0 ? 'expired' : d <= CERT_WARN_DAYS ? 'expiring' : 'current'; }
  function certPill(expiry) { const s = certState(expiry); const d = daysUntil(expiry); return s === 'expired' ? pill(`Expired ${fmtD(expiry)}`, 'red') : s === 'expiring' ? pill(`Expires in ${d} d`, 'amber') : s === 'current' ? pill(`Valid to ${fmtD(expiry)}`, 'green') : pill('No expiry', 'grey'); }
  async function renderCerts() {
    const certs = (await VMS.certifications()).map(c => ({ ...c, state: certState(c.expiry), expD: toDate(c.expiry), effD: toDate(c.effective) }));
    const q = state.q;
    const counts = { expired: 0, expiring: 0, current: 0, none: 0 }; certs.forEach(c => counts[c.state]++);
    const rows = sortRows(certs.filter(c => (state.certFilter === 'all' || c.state === state.certFilter) && matches(q, c.name, c.qualification)), 'certs', 'expD', 1);
    main.innerHTML = `<div class="wrap">
      <div class="stats"><div class="stat ${counts.expired ? 'warn' : ''}"><b>${counts.expired}</b><span>expired</span></div><div class="stat ${counts.expiring ? 'warn' : ''}"><b>${counts.expiring}</b><span>expiring ≤ ${CERT_WARN_DAYS} days</span></div><div class="stat"><b>${counts.current}</b><span>current</span></div><div class="stat"><b>${new Set(certs.map(c => c.name)).size}</b><span>members with certs</span></div></div>
      <div class="bar">
        <div class="seg">${[['all', 'All'], ['expired', 'Expired'], ['expiring', 'Expiring'], ['current', 'Current'], ['none', 'No expiry']].map(([k, l]) => `<button data-cf="${k}" class="${state.certFilter === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <input type="search" placeholder="Filter by member or qualification…" value="${esc(q)}"><button class="btn" id="d7-csv">Download CSV</button>
      </div>
      <div class="tbl"><table><thead><tr>${th('Member', 'name', 'certs', 'expD')}${th('Qualification', 'qualification', 'certs', 'expD')}${th('Effective', 'effD', 'certs', 'expD')}${th('Expiry', 'expD', 'certs', 'expD')}<th>Status</th>${th('Source', 'source', 'certs', 'expD')}</tr></thead><tbody>
        ${rows.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.qualification)}</td><td>${esc(fmtD(c.effD) || c.effective)}</td><td>${esc(fmtD(c.expD) || c.expiry)}</td><td>${certPill(c.expiry)}</td><td class="muted">${esc(c.source)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted" style="font-size:12px">Source: Group Lead → Reports → Qualifications and Certifications. VMS only exposes certifications through windowed reports; this combines all of them (gained in the last two years, expired in the last 12 months, or expiring by the end of next year). Older certifications that expire later than next year are not visible.</p>
    </div>`;
    main.querySelectorAll('[data-cf]').forEach(b => b.addEventListener('click', () => { state.certFilter = b.dataset.cf; renderCerts(); }));
    const inp = main.querySelector('input[type=search]'); inp.addEventListener('input', () => { state.q = inp.value; renderCerts(); });
    bindSort(main, renderCerts);
    main.querySelector('#d7-csv').addEventListener('click', () => downloadCSV('d0007-certifications.csv', ['Member', 'Qualification', 'Effective', 'Expiry', 'Status', 'Source'], rows.map(c => [c.name, c.qualification, c.effective, c.expiry, c.state, c.source])));
  }

  function downloadCSV(filename, head, rows) {
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
    const a = el('a', { href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })), download: filename }); document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  // --- shell ------------------------------------------------------------
  function open() {
    if (root) { root.style.display = 'flex'; return; }
    if (!document.getElementById('d0007-css')) document.head.appendChild(el('style', { id: 'd0007-css' }, CSS));
    root = el('div', { id: 'd0007-root', role: 'dialog', 'aria-label': 'D0007 Ops Console' });
    root.innerHTML = `<header><h1>${esc(UNIT_LABEL)}</h1><span class="sub">Ops Console · prototype · read-only</span><span class="sp"></span><button class="btn" id="d7-refresh" title="Re-fetch everything from VMS">Refresh</button><button class="btn" id="d7-close">Close ✕</button></header>
      <nav>${[['events', 'Events'], ['roster', 'Roster'], ['hours', 'Hours'], ['certs', 'Certifications']].map(([k, l]) => `<button data-tab="${k}">${l}</button>`).join('')}</nav>
      <main></main>
      <footer>Data comes live from your VMS session (Group Lead pages, reports and CSV feeds). Nothing here writes back to VMS. Times shown in Eastern.</footer>`;
    document.body.appendChild(root);
    main = root.querySelector('main');
    root.querySelector('#d7-close').addEventListener('click', close);
    root.querySelector('#d7-refresh').addEventListener('click', () => { VMS.clear(); render(); });
    root.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; state.q = ''; render(); }));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && root && root.style.display !== 'none') close(); });
    render();
  }
  function close() { if (root) root.style.display = 'none'; }

  window.D0007 = { open, close, VMS, version: '0.1.1' };

  // Floating launcher button. Skip it inside iframes (the portal loads entity
  // forms in modals and the script would run there too).
  if (window.top === window.self && document.body) {
    const b = el('button', { id: 'd0007-launch', type: 'button', title: 'Open the D0007 Ops Console' }, 'D0007');
    b.addEventListener('click', open);
    document.body.appendChild(b);
    if (location.hash === '#d0007') open();
  }
})();
