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

  // --- local store ------------------------------------------------------
  // Unit-side info that VMS has no fields for: meet times, kits, vehicles,
  // coordinator, row colours, who's Command/Driver/Sr, etc. Lives in
  // localStorage on this browser only. Export/import moves it between people.
  const Store = (() => {
    const KEY = 'camsvms.v1';
    const SECTIONS = ['schedule', 'members', 'settings'];
    let data = null;
    function load() {
      if (data) return data;
      try { data = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { data = {}; }
      if (!data || typeof data !== 'object') data = {};
      SECTIONS.forEach(k => { if (!data[k] || typeof data[k] !== 'object') data[k] = {}; });
      return data;
    }
    function save() { try { localStorage.setItem(KEY, JSON.stringify(load())); } catch (e) { /* private mode, quota, whatever - keep going in memory */ } }
    const get = (section, key) => load()[section][key];
    const set = (section, key, value) => {
      const d = load();
      if (value === undefined || value === null) delete d[section][key]; else d[section][key] = value;
      save();
    };
    // merge a partial object into an entry (handy for one-field edits)
    const patch = (section, key, partial) => set(section, key, { ...(get(section, key) || {}), ...partial });
    const all = section => ({ ...load()[section] });
    const exportJSON = () => JSON.stringify({ exported: new Date().toISOString(), ...load() }, null, 2);
    const importJSON = (text, { merge = true } = {}) => {
      const inc = JSON.parse(text); const d = load();
      SECTIONS.forEach(k => { const src = inc[k] && typeof inc[k] === 'object' ? inc[k] : {}; d[k] = merge ? { ...d[k], ...src } : { ...src }; });
      save();
    };
    const reset = () => { data = {}; SECTIONS.forEach(k => data[k] = {}); save(); };
    return { get, set, patch, all, exportJSON, importJSON, reset, KEY };
  })();
  D.Store = Store;

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
  D.VMS = VMS;

  // --- event schedule ---------------------------------------------------
  // The unit's monthly Event Schedule: one row per event day, who's on it,
  // when to meet, what kit, which truck. Until now that was an Excel sheet
  // filled in by hand from the VMS event pages, one event at a time, every
  // month. VMS has the event, the location, the sign-ups and the shifts. It has
  // no field for anything else on the sheet (meet-at-St.John time, coordinator,
  // requirement, notes, kits, vehicles, row colour, who's Command/Driver/Sr),
  // so those live in Store and get merged over the VMS side here.
  const Schedule = (() => {
    const COLUMNS = ['Event', 'Date', 'Meet @ St.John', 'Meet @ Event', 'Approx. End', 'Event Location', 'On-Site Coordinator', 'Event Notes', 'Medical First Responders', 'Apprentice', 'Equipment', 'Vehicle'];
    // The sheet's row fills. Red and cyan are in use but nobody wrote down what for.
    const COLOURS = [
      { hex: '#FFFF00', label: 'Stadium / sports' },
      { hex: '#00FF00', label: 'Community event' },
      { hex: '#FF00FF', label: 'Training night' },
      { hex: '#4A86E8', label: 'Multi-day / provincial' },
      { hex: '#FF0000', label: 'Red' },
      { hex: '#FF9900', label: 'Training exercise' },
      { hex: '#00FFFF', label: 'Cyan' },
    ];
    const TAGS = ['C', 'D', 'Sr'];
    const FIELDS = ['meetSJ', 'meetEvent', 'approxEnd', 'coordinator', 'notes', 'requirement', 'equipment', 'vehicle', 'colour'];
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

    // --- dates. Everything is keyed on the Eastern calendar date, worked out
    // through Intl so it doesn't matter what zone the browser thinks it's in.
    const F_NUM = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const F_LABEL = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
    const partsOf = (fmt, d) => { const o = {}; fmt.formatToParts(d).forEach(p => { if (p.type !== 'literal') o[p.type] = p.value; }); return o; };
    const ymd = v => { const d = toDate(v); if (!d) return ''; const p = partsOf(F_NUM, d); return `${p.year}-${p.month}-${p.day}`; };
    const hm = v => { const d = toDate(v); if (!d) return ''; const p = partsOf(F_NUM, d); return `${p.hour}:${p.minute}`; };
    // "Sat Oct 24" for a YYYY-MM-DD. Noon UTC is still that date in Eastern.
    const dayLabel = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); if (!m) return ''; const p = partsOf(F_LABEL, new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12))); return `${p.weekday} ${p.month} ${p.day}`; };
    const today = () => { const p = partsOf(F_NUM, new Date()); return { year: +p.year, month: +p.month }; };
    const monthName = m => MONTHS[m - 1] || '';
    const monthLabel = (y, m) => `${monthName(m)} ${y}`;

    const isCancelled = s => /cancel/i.test(s || '');
    const isWaitlist = s => /wait ?list/i.test(s || '');
    const isNoShow = s => /no.?show/i.test(s || '');

    // --- roles and tags. Apprentice unless there's a current MFR cert on file,
    // and whatever is set on the Roster tab wins over that.
    const MFR_RE = /medical first responder/i;
    function autoRole(name, certs = [], now = Date.now()) {
      const n = norm(name);
      const ok = certs.some(c => norm(c.name) === n && MFR_RE.test(c.qualification || '') && (!c.expiry || ((toDate(c.expiry)?.getTime() ?? 0) + 86400000) > now));
      return ok ? 'MFR' : 'Apprentice';
    }
    function memberInfo(name, { certs = [], members = {}, now } = {}) {
      const m = members[norm(name)] || {};
      const auto = autoRole(name, certs, now);
      const set = m.role === 'MFR' || m.role === 'Apprentice';
      return { role: set ? m.role : auto, autoRole: auto, roleSet: set, tags: TAGS.filter(t => Array.isArray(m.tags) && m.tags.includes(t)), unit: String(m.unit || '').trim() };
    }

    // --- one day's shifts → meet time, end time, people, partial-shift notes.
    // The "main" shift is the start time most people share (earliest on a tie)
    // and its most common length. Anyone whose window differs is partial: they
    // get a star on their name and a line in the notes, one star-group per
    // distinct window in the order they turn up.
    function deriveDay(shifts) {
      const by = new Map();
      shifts.forEach(s => {
        const start = toDate(s.start); if (!start || isCancelled(s.status)) return;
        const end = new Date(start.getTime() + Math.max(0, num(s.hours)) * 3600000);
        const k = norm(s.name);
        const cur = by.get(k);
        if (!cur) by.set(k, { name: s.name, start, end, hours: num(s.hours), status: s.status || '' });
        else { if (start < cur.start) cur.start = start; if (end > cur.end) cur.end = end; cur.hours += num(s.hours); if (isNoShow(cur.status) && !isNoShow(s.status)) cur.status = s.status || ''; }
      });
      const all = [...by.values()].sort((a, b) => a.start - b.start || norm(a.name).localeCompare(norm(b.name)));
      const waitlisted = all.filter(p => isWaitlist(p.status)).map(p => ({ name: p.name, status: p.status }));
      const people = all.filter(p => !isWaitlist(p.status));
      const counted = people.filter(p => !isNoShow(p.status));
      const pool = counted.length ? counted : people;
      const mode = (items, key, tie) => { const c = new Map(); items.forEach(x => c.set(key(x), (c.get(key(x)) || 0) + 1)); let best = null; for (const x of items) { const k = key(x); if (!best || c.get(k) > best.n || (c.get(k) === best.n && tie(x, best.x))) best = { x, n: c.get(k), k }; } return best ? best.x : null; };
      const lead = mode(pool, p => p.start.getTime(), (a, b) => a.start < b.start);
      const mainStart = lead ? lead.start : null;
      const same = pool.filter(p => mainStart && p.start.getTime() === mainStart.getTime());
      const lengthLead = mode(same, p => p.hours, (a, b) => a.hours > b.hours);
      const mainEnd = mainStart ? new Date(mainStart.getTime() + (lengthLead ? lengthLead.hours : 0) * 3600000) : null;
      const meetEvent = mainStart ? hm(mainStart) : '';
      const approxEnd = mainEnd && mainEnd > mainStart ? hm(mainEnd) : '';
      const notes = [], variants = new Map();
      const out = people.map(p => {
        const partialOf = mainStart && (p.start.getTime() !== mainStart.getTime() || p.end.getTime() !== mainEnd.getTime());
        let partial = null;
        if (partialOf) {
          const vk = p.start.getTime() + '-' + p.end.getTime();
          if (!variants.has(vk)) {
            const marker = '*'.repeat(variants.size + 2);
            variants.set(vk, marker);
            notes.push(`${marker}${hm(p.start)} to ${p.end.getTime() === mainEnd.getTime() ? 'End' : hm(p.end)}`);
          }
          const marker = variants.get(vk);
          partial = { start: hm(p.start), end: hm(p.end), marker, mark: marker.slice(1) };
        }
        return { name: p.name, start: p.start, end: p.end, hours: p.hours, status: p.status, partial };
      });
      return { meetEvent, approxEnd, mainStart, mainEnd, people: out, notes, waitlisted };
    }

    // --- one event (+ its detail) → one row per day it has shifts on. No
    // shifts at all and it gets one row on its start date so it still shows up.
    const peopleOrder = (a, b) => { const r = t => a.tags.includes(t) === b.tags.includes(t) ? 0 : a.tags.includes(t) ? -1 : 1; return r('C') || r('D') || norm(a.name).localeCompare(norm(b.name)); };
    function eventRows(e, detail, ctx = {}) {
      const d = detail || {};
      const info = name => memberInfo(name, ctx);
      const byDay = new Map();
      (d.shifts || []).forEach(s => { if (isCancelled(s.status)) return; const k = ymd(s.start); if (!k) return; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(s); });
      const days = byDay.size ? [...byDay.keys()].sort() : [ymd(e.start)].filter(Boolean);
      const scheduled = new Set((d.shifts || []).filter(s => !isCancelled(s.status)).map(s => norm(s.name)));
      // Signed up but never given a shift, on any day. Worth a nudge.
      const signedUpNoShift = (d.participants || []).filter(p => !isCancelled(p.status) && !/declin|reject/i.test(p.status || '') && !scheduled.has(norm(p.name))).map(p => ({ name: p.name, status: p.status, role: info(p.name).role }));
      const startDay = ymd(e.start);
      return days.map(date => {
        const day = deriveDay(byDay.get(date) || []);
        const people = day.people.map(p => ({ ...p, ...info(p.name) })).sort(peopleOrder);
        const row = {
          key: `${e.id}|${date}`, eventId: e.id, title: e.title || '', location: e.location || '', program: e.program || '', eventStatus: e.status || '',
          date, dateLabel: dayLabel(date), eventStart: e.start || null, startMismatch: !!startDay && startDay !== date && byDay.size > 0 && date === days[0],
          derived: { meetEvent: day.meetEvent, approxEnd: day.approxEnd, notes: day.notes },
          people, signedUpNoShift, waitlisted: day.waitlisted.map(w => ({ ...w, role: info(w.name).role })), shiftCount: (byDay.get(date) || []).length,
          error: d.error || '',
        };
        return withOverrides(row);
      });
    }

    // Merge what's in Store over the derived values. Empty override = use VMS.
    function withOverrides(row) {
      const st = Store.get('schedule', row.key) || {};
      const pick = (f, dflt = '') => { const v = st[f]; return v === undefined || v === null || String(v) === '' ? dflt : String(v); };
      const out = { ...row, stored: { ...st } };
      out.meetSJ = pick('meetSJ'); out.meetEvent = pick('meetEvent', row.derived.meetEvent); out.approxEnd = pick('approxEnd', row.derived.approxEnd);
      out.coordinator = pick('coordinator'); out.notes = pick('notes'); out.requirement = pick('requirement'); out.equipment = pick('equipment'); out.vehicle = pick('vehicle');
      const col = pick('colour').toUpperCase(); out.colour = COLOURS.some(c => c.hex === col) ? col : '';
      out.edited = { meetEvent: !!pick('meetEvent') && pick('meetEvent') !== row.derived.meetEvent, approxEnd: !!pick('approxEnd') && pick('approxEnd') !== row.derived.approxEnd };
      return out;
    }

    // Run fn over items with at most n in flight. The event-summary page is
    // three fetches per event and there's no need to hit the portal with
    // thirty of them at once.
    async function pmap(items, fn, n = 4) {
      const out = new Array(items.length); let i = 0;
      await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
      return out;
    }

    async function monthRows(year, month) {
      const prefix = `${year}-${String(month).padStart(2, '0')}`;
      const [ev, certs] = await Promise.all([VMS.groupEvents(), VMS.certifications().catch(() => [])]);
      const members = Store.all('members');
      const seen = new Set(), events = [];
      ['current', 'upcoming', 'past'].forEach(k => (ev[k] || []).forEach(e => { if (e.id && !seen.has(e.id)) { seen.add(e.id); events.push(e); } }));
      // Only open events that could have a day in this month: anything starting
      // in the six weeks before it (a fair that runs across the month end) up to
      // the end of it. Past events go back years and every one is three fetches.
      const lo = ymd(new Date(Date.UTC(year, month - 1, 1) - 45 * 86400000)), hi = `${prefix}-31`;
      const cand = events.filter(e => { const s = ymd(e.start); return s && s >= lo && s <= hi; });
      const details = await pmap(cand, e => VMS.eventDetail(e.id).catch(err => ({ error: err.message || String(err), participants: [], shifts: [] })), 4);
      const rows = [];
      cand.forEach((e, i) => eventRows(e, details[i], { certs, members }).forEach(r => { if (r.date.startsWith(prefix)) rows.push(r); }));
      rows.sort((a, b) => a.date.localeCompare(b.date) || a.meetEvent.localeCompare(b.meetEvent) || norm(a.title).localeCompare(norm(b.title)));
      return rows;
    }

    // --- the sheet's cells
    const formatName = p => `${p.name}${p.tags && p.tags.length ? ' ' + p.tags.join('/') : ''}${p.unit ? ` (${p.unit})` : ''}${p.partial ? p.partial.mark : ''}`;
    const lines = s => String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const eventNotes = r => [...lines(r.requirement), ...((r.derived && r.derived.notes) || []), ...lines(r.notes)].join('\n');
    function rowCells(r) {
      const names = role => (r.people || []).filter(p => p.role === role).map(formatName).join('\n');
      return [r.title, r.dateLabel, r.meetSJ, r.meetEvent, r.approxEnd, r.location, r.coordinator, eventNotes(r), names('MFR'), names('Apprentice'), lines(r.equipment).join('\n'), lines(r.vehicle).join('\n')].map(v => String(v ?? ''));
    }
    // Header first, a blank spacer between dates like the sheet, cells with
    // line breaks quoted so Excel and Sheets keep them in one cell.
    function toWorkbookRows(rows, { spacers = true } = {}) {
      const out = [COLUMNS.slice()], colours = ['']; let prev = null;
      (rows || []).forEach(r => {
        if (spacers && prev && prev !== r.date) { out.push(COLUMNS.map(() => '')); colours.push(''); }
        out.push(rowCells(r)); colours.push(r.colour || ''); prev = r.date;
      });
      return { rows: out, colours };
    }
    const tsvCell = v => /[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const toTSV = (rows, opts) => toWorkbookRows(rows, opts).rows.map(r => r.map(tsvCell).join('\t')).join('\n');

    // --- .xlsx. The SheetJS community build writes cells but drops every
    // style, and the fills are the one thing this sheet actually relies on.
    // An xlsx is a zip of a few XML files, so this writes them directly
    // (stored, no compression - a month is a few KB).
    const WIDTHS = [28, 11, 9, 9, 9, 24, 18, 36, 26, 20, 12, 12];
    const xmlEsc = s => String(s ?? '').replace(/[^\t\n\r\x20-￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const colRef = i => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
    const utf8 = s => { const o = []; for (const ch of s) { const c = ch.codePointAt(0); if (c < 0x80) o.push(c); else if (c < 0x800) o.push(0xC0 | c >> 6, 0x80 | c & 63); else if (c < 0x10000) o.push(0xE0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63); else o.push(0xF0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63); } return Uint8Array.from(o); };
    const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
    const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
    function zipStored(files) {
      const u16 = n => [n & 255, n >>> 8 & 255], u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
      const now = new Date(), tm = now.getHours() << 11 | now.getMinutes() << 5 | now.getSeconds() >> 1, dt = (now.getFullYear() - 1980) << 9 | (now.getMonth() + 1) << 5 | now.getDate();
      const parts = [], central = []; let off = 0;
      for (const f of files) {
        const name = utf8(f.name), data = utf8(f.text), crc = crc32(data);
        const local = Uint8Array.from([...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(tm), ...u16(dt), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)]);
        central.push(Uint8Array.from([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(tm), ...u16(dt), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off)]), name);
        parts.push(local, name, data); off += local.length + name.length + data.length;
      }
      const cdSize = central.reduce((a, b) => a + b.length, 0);
      const end = Uint8Array.from([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(off), ...u16(0)]);
      const all = [...parts, ...central, end], out = new Uint8Array(all.reduce((a, b) => a + b.length, 0)); let p = 0; all.forEach(b => { out.set(b, p); p += b.length; });
      return out;
    }
    function toXLSX(rows, { sheetName = 'Schedule' } = {}) {
      const { rows: aoa, colours } = toWorkbookRows(rows);
      const name = String(sheetName).replace(/[\[\]:*?\/\\]/g, '').slice(0, 31) || 'Schedule';
      const styleOf = (ri, hex) => ri === 0 ? 1 : hex ? 2 + COLOURS.findIndex(c => c.hex === hex) : 0;
      const sheetRows = aoa.map((cells, ri) => {
        const s = styleOf(ri, colours[ri]);
        const nLines = Math.max(1, ...cells.map((v, ci) => lines(v).reduce((a, l) => a + Math.max(1, Math.ceil(l.length / WIDTHS[ci])), 0)));
        const cs = cells.map((v, ci) => v === '' ? (s ? `<c r="${colRef(ci)}${ri + 1}" s="${s}"/>` : '') : `<c r="${colRef(ci)}${ri + 1}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`).join('');
        return `<row r="${ri + 1}" ht="${15 * nLines + 3}" customHeight="1">${cs}</row>`;
      }).join('');
      const xml = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
      const sheet = xml(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${colRef(COLUMNS.length - 1)}${aoa.length}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${WIDTHS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${sheetRows}</sheetData><pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`);
      const fills = COLOURS.map(c => `<fill><patternFill patternType="solid"><fgColor rgb="FF${c.hex.slice(1)}"/><bgColor indexed="64"/></patternFill></fill>`).join('');
      const align = '<alignment vertical="top" wrapText="1"/>';
      const xfs = [`<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1">${align}</xf>`, `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">${align}</xf>`, ...COLOURS.map((c, i) => `<xf numFmtId="0" fontId="0" fillId="${i + 2}" borderId="0" xfId="0" applyFill="1" applyAlignment="1">${align}</xf>`)];
      const styles = xml(`<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="${COLOURS.length + 2}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fills}</fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
      return zipStored([
        { name: '[Content_Types].xml', text: xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>') },
        { name: '_rels/.rels', text: xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
        { name: 'xl/workbook.xml', text: xml(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
        { name: 'xl/_rels/workbook.xml.rels', text: xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') },
        { name: 'xl/styles.xml', text: styles },
        { name: 'xl/worksheets/sheet1.xml', text: sheet },
      ]);
    }

    return { COLUMNS, COLOURS, TAGS, FIELDS, monthRows, eventRows, deriveDay, withOverrides, memberInfo, autoRole, formatName, eventNotes, rowCells, toTSV, toWorkbookRows, toXLSX, ymd, hm, dayLabel, today, monthName, monthLabel };
  })();
  D.Schedule = Schedule;

  // --- styles -----------------------------------------------------------
  // Everything is scoped under #d0007-root so we don't fight the portal css.
  const CSS = `
#d0007-root{position:fixed;inset:0;z-index:2147483000;background:#f3f5f2;color:#1d2a1f;font:14px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;display:flex;flex-direction:column;overflow:hidden}
#d0007-root *{box-sizing:border-box}
#d0007-root a{color:#2f6b3a}
#d0007-root header{background:#1f4d2b;color:#fff;padding:10px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
#d0007-root header h1{font-size:16px;margin:0;font-weight:600;letter-spacing:.2px}
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
  // Screens append their own css here so they don't have to edit this file.
  const CSS_PARTS = [CSS];

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
    const tab = TABS.find(t => t.id === state.tab) || TABS[0];
    Promise.resolve().then(() => tab.render()).catch(e => { main.innerHTML = `<div class="wrap"><div class="err"><b>Couldn't load data.</b> ${esc(e.message || e)}</div></div>`; });
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
  TABS.push({ id: 'events', label: 'Events', render: renderEvents });

  // ---- Schedule ----
  // The monthly Event Schedule, on screen. Same twelve columns as the sheet,
  // one row per event day, VMS filling in what it knows and the rest typed
  // straight into the cell. "Copy month for spreadsheet" is for anyone who
  // still wants it in Excel.
  // Month lives on state (so it survives a Refresh); the rest is ours.
  const sched = { rows: [], req: 0, flashTimer: null };
  const SCHED_MULTI = new Set(['notes', 'requirement', 'equipment', 'vehicle']);
  const SCHED_LABEL = { meetSJ: 'Meet @ St.John', meetEvent: 'Meet @ Event', approxEnd: 'Approx. End', coordinator: 'On-Site Coordinator', requirement: 'Requirement (e.g. 1 Command / 1 Driver / 3 MFR)', notes: 'Notes', equipment: 'Equipment, one per line', vehicle: 'Vehicle, one per line' };
  const SCHED_PLACEHOLDER = { requirement: 'Requirement', notes: 'Notes' };
  // The sheet's fills are full-strength; on screen that's unreadable, so mix
  // them 80% towards white and keep the real hex for the swatch and the export.
  const tint = hex => { const n = parseInt(hex.slice(1), 16); const mix = v => Math.round(v * 0.2 + 255 * 0.8); return `rgb(${mix(n >> 16 & 255)},${mix(n >> 8 & 255)},${mix(n & 255)})`; };
  const vmsEventLink = id => `/en-US/group-lead/event-summary/?eventid=${encodeURIComponent(id)}&groupid=${GROUP_ID}`;

  async function renderSchedule() {
    if (!state.schedY) { const t = Schedule.today(); state.schedY = t.year; state.schedM = t.month; }
    scheduleFrame();
    const req = ++sched.req;
    const rows = await Schedule.monthRows(state.schedY, state.schedM);
    if (req !== sched.req) return;   // user moved on to another month while this one loaded
    sched.rows = rows;
    paintSchedule();
  }
  // Header bar plus an empty table slot. Separate from the paint so it can be
  // put back if another tab's slow render lands on top of ours.
  function scheduleFrame() {
    main.innerHTML = `<div class="wrap wide">
      <div class="bar sched-bar">
        <div class="seg"><button data-nav="-1" title="Previous month">‹</button><button data-nav="0">This month</button><button data-nav="1" title="Next month">›</button></div>
        <h2 class="sched-h">${esc(Schedule.monthLabel(state.schedY, state.schedM))}</h2>
        <span class="sp"></span>
        <button class="btn" id="d7-copy" disabled title="Copies the month as tab-separated text, ready to paste over the sheet">Copy month for spreadsheet</button>
        <button class="btn" id="d7-xlsx" disabled>Download .xlsx</button>
        <button class="btn" id="d7-print" disabled>Print</button>
        <span class="sched-flash" id="d7-flash" aria-live="polite"></span>
      </div>
      <div id="d7-sched"><div class="load">Loading events…</div></div>
      <p class="muted sched-foot">Event, date, location, meet-at-event, approx. end and the names come from VMS (shifts on the event). Everything else is typed here and kept in this browser - see the Data tab to move it between people. Click a cell to edit; Enter saves, Esc cancels; clearing Meet @ Event or Approx. End goes back to the VMS value. Colours: ${Schedule.COLOURS.map(c => `<span class="sw" style="background:${c.hex}"></span> ${esc(c.label)}`).join(' · ')}</p>
    </div>`;
    main.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => {
      const n = +b.dataset.nav;
      if (n === 0) { const t = Schedule.today(); state.schedY = t.year; state.schedM = t.month; }
      else { state.schedM += n; if (state.schedM < 1) { state.schedM = 12; state.schedY--; } if (state.schedM > 12) { state.schedM = 1; state.schedY++; } }
      render();
    }));
    main.querySelector('#d7-copy').addEventListener('click', copySchedule);
    main.querySelector('#d7-xlsx').addEventListener('click', downloadSchedule);
    main.querySelector('#d7-print').addEventListener('click', printSchedule);
  }

  function paintSchedule() {
    if (state.tab !== 'schedule') return;
    if (!main.querySelector('#d7-sched')) scheduleFrame();   // something else painted main while we were fetching
    const box = main.querySelector('#d7-sched');
    const rows = sched.rows;
    main.querySelectorAll('#d7-copy,#d7-xlsx,#d7-print').forEach(b => { b.disabled = !rows.length; });
    if (!rows.length) { box.innerHTML = `<div class="card muted">No events with a day in ${esc(Schedule.monthLabel(state.schedY, state.schedM))}.</div>`; return; }
    let body = '', prev = null;
    rows.forEach(r => {
      if (prev && prev !== r.date) body += `<tr class="sched-gap"><td colspan="${Schedule.COLUMNS.length}"></td></tr>`;
      body += `<tr class="sched-row" data-key="${esc(r.key)}" style="${rowStyle(r)}">${rowHTML(r)}</tr>`; prev = r.date;
    });
    box.innerHTML = `<div class="tbl sched-tbl"><table class="sched-table"><thead><tr>${Schedule.COLUMNS.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
    box.querySelectorAll('tr[data-key]').forEach(bindRow);
  }
  const rowStyle = r => r.colour ? `--tint:${tint(r.colour)}` : '';
  function rowHTML(r) {
    const ed = field => {
      const v = r[field] || '', edited = r.edited && r.edited[field];
      const tip = `${SCHED_LABEL[field]} - click to edit${edited ? `. VMS says ${r.derived[field] || 'nothing'}; clear the cell to use that` : ''}`;
      return `<div class="ed" data-field="${field}" title="${esc(tip)}" tabindex="0">${v ? esc(v).replace(/\n/g, '<br>') : `<span class="muted">${esc(SCHED_PLACEHOLDER[field] || '—')}</span>`}${edited ? '<i class="edited" title="Edited here; VMS has a different value"></i>' : ''}</div>`;
    };
    const person = p => `<div class="nm">${esc(p.name)}${p.tags.length ? ` <b class="tag">${esc(p.tags.join('/'))}</b>` : ''}${p.unit ? ` <span class="muted">(${esc(p.unit)})</span>` : ''}${p.partial ? `<b class="star" title="${esc(p.partial.start + ' to ' + p.partial.end)}">${esc(p.partial.mark)}</b>` : ''}${/no.?show/i.test(p.status) ? ' <span class="pill red">no show</span>' : ''}</div>`;
    const names = role => {
      const ps = r.people.filter(p => p.role === role).map(person);
      const extra = [...r.waitlisted.filter(p => p.role === role).map(p => `<div class="nm muted">${esc(p.name)} <span class="why">(waitlist)</span></div>`), ...r.signedUpNoShift.filter(p => p.role === role).map(p => `<div class="nm muted">${esc(p.name)} <span class="why">(signed up, no shift)</span></div>`)];
      return ps.join('') + (ps.length || extra.length ? '' : '<span class="muted">—</span>') + extra.join('');
    };
    const swatches = `<span class="sw-row">${[{ hex: '', label: 'No colour' }, ...Schedule.COLOURS].map(c => `<button type="button" class="sw ${r.colour === c.hex ? 'on' : ''}" data-colour="${c.hex}" title="${esc(c.label)}" style="background:${c.hex || '#fff'}"></button>`).join('')}</span>`;
    return `<td class="c-event"><div class="ev-t">${esc(r.title)}</div><div class="ev-m"><a href="${esc(vmsEventLink(r.eventId))}" target="_blank" rel="noopener">Open in VMS ↗</a>${r.error ? ` <span class="pill red" title="${esc(r.error)}">detail failed</span>` : ''}${r.shiftCount ? '' : ' <span class="muted">no shifts yet</span>'}</div>${swatches}</td>
      <td class="c-date"><b>${esc(r.dateLabel)}</b>${r.startMismatch ? `<div class="muted why">VMS start ${esc(fmtD(r.eventStart))}</div>` : ''}</td>
      <td>${ed('meetSJ')}</td><td>${ed('meetEvent')}</td><td>${ed('approxEnd')}</td>
      <td>${esc(r.location) || '<span class="muted">—</span>'}</td>
      <td>${ed('coordinator')}</td>
      <td class="c-notes">${ed('requirement')}${r.derived.notes.length ? `<div class="auto" title="From the shifts in VMS">${r.derived.notes.map(esc).join('<br>')}</div>` : ''}${ed('notes')}</td>
      <td class="c-names">${names('MFR')}</td><td class="c-names">${names('Apprentice')}</td>
      <td>${ed('equipment')}</td><td>${ed('vehicle')}</td>`;
  }
  function bindRow(tr) {
    const row = sched.rows.find(r => r.key === tr.dataset.key); if (!row) return;
    tr.querySelectorAll('.ed[data-field]').forEach(d => {
      d.addEventListener('click', () => startEdit(tr, row, d.dataset.field));
      d.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === d) { e.preventDefault(); startEdit(tr, row, d.dataset.field); } });
    });
    tr.querySelectorAll('.sw[data-colour]').forEach(b => b.addEventListener('click', () => saveField(tr, row, 'colour', b.dataset.colour)));
  }
  function saveField(tr, row, field, value) {
    Store.patch('schedule', row.key, { [field]: value });
    Object.assign(row, Schedule.withOverrides(row));
    tr.style.cssText = rowStyle(row); tr.innerHTML = rowHTML(row); bindRow(tr);
  }
  function startEdit(tr, row, field) {
    const box = tr.querySelector(`.ed[data-field="${field}"]`); if (!box || box.querySelector('input,textarea')) return;
    const multi = SCHED_MULTI.has(field), cur = row[field] || '';
    box.innerHTML = multi ? `<textarea rows="${Math.min(6, Math.max(2, cur.split('\n').length + 1))}" placeholder="${esc(SCHED_LABEL[field])}">${esc(cur)}</textarea>` : `<input type="text" value="${esc(cur)}" placeholder="${esc(field === 'meetSJ' || field === 'meetEvent' || field === 'approxEnd' ? 'HH:MM' : SCHED_LABEL[field])}">`;
    const inp = box.firstElementChild; inp.focus(); if (!multi) inp.select();
    let done = false;
    const finish = save => {
      if (done) return; done = true;
      if (save && inp.value !== cur) saveField(tr, row, field, inp.value);
      else { tr.innerHTML = rowHTML(row); bindRow(tr); }
    };
    inp.addEventListener('blur', () => finish(true));
    inp.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      else if (e.key === 'Enter' && (!multi || e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); }
    });
  }
  function flash(msg) {
    const f = main.querySelector('#d7-flash'); if (!f) return;
    f.textContent = msg; clearTimeout(sched.flashTimer); sched.flashTimer = setTimeout(() => { f.textContent = ''; }, 3000);
  }
  async function copySchedule() {
    const tsv = Schedule.toTSV(sched.rows);
    let ok = false;
    try { await navigator.clipboard.writeText(tsv); ok = true; } catch (e) { /* no clipboard permission - try the old way */ }
    if (!ok) {
      const ta = el('textarea', { style: 'position:fixed;left:-9999px;top:0', 'aria-hidden': 'true' }); ta.value = tsv; root.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
    }
    flash(ok ? `Copied ${sched.rows.length} rows. Paste into the sheet with the Event column selected.` : 'Copy failed - the browser blocked clipboard access.');
  }
  function downloadSchedule() {
    const name = `Event Schedule ${Schedule.monthLabel(state.schedY, state.schedM)}.xlsx`;
    const bytes = Schedule.toXLSX(sched.rows, { sheetName: Schedule.monthName(state.schedM) });
    const a = el('a', { href: URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })), download: name });
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    flash(`Saved ${name}`);
  }
  function printSchedule() {
    // Landscape only while we're the ones printing; the portal's own pages can
    // keep whatever orientation they had.
    document.body.classList.add('d7-print');
    const page = el('style', { id: 'd7-print-page' }, '@page{size:landscape;margin:10mm}'); document.head.appendChild(page);
    const off = () => { document.body.classList.remove('d7-print'); page.remove(); window.removeEventListener('afterprint', off); };
    window.addEventListener('afterprint', off);
    window.print();
    setTimeout(off, 1000);   // Safari doesn't always fire afterprint
  }

  CSS_PARTS.push(`
#d0007-root .wrap.wide{max-width:none}
#d0007-root .sched-h{font-size:18px;margin:0 6px;font-weight:600;color:#1f4d2b;white-space:nowrap}
#d0007-root .sched-flash{font-size:12.5px;color:#1f5a2c;flex-basis:100%}
#d0007-root .sched-flash:empty{display:none}
#d0007-root .sched-tbl{max-height:75vh}
#d0007-root .sched-table{min-width:1400px;table-layout:fixed}
#d0007-root .sched-table th{cursor:default;z-index:2;white-space:normal;vertical-align:bottom}
#d0007-root .sched-table th:first-child,#d0007-root .sched-table td:first-child{position:sticky;left:0}
#d0007-root .sched-table th:first-child{z-index:3}
#d0007-root .sched-table td:first-child{z-index:1;border-right:1px solid #dfe5e0}
#d0007-root .sched-table td{background:var(--tint,#fff);vertical-align:top;font-size:12.5px}
#d0007-root .sched-table th:nth-child(1){width:200px}
#d0007-root .sched-table th:nth-child(2){width:88px}
#d0007-root .sched-table th:nth-child(3),#d0007-root .sched-table th:nth-child(4),#d0007-root .sched-table th:nth-child(5){width:72px}
#d0007-root .sched-table th:nth-child(6){width:140px}
#d0007-root .sched-table th:nth-child(7){width:120px}
#d0007-root .sched-table th:nth-child(8){width:200px}
#d0007-root .sched-table th:nth-child(9){width:170px}
#d0007-root .sched-table th:nth-child(10){width:150px}
#d0007-root .sched-table th:nth-child(11),#d0007-root .sched-table th:nth-child(12){width:80px}
#d0007-root .sched-gap td{height:7px;padding:0;background:#f3f5f2;border-bottom:0}
#d0007-root .ev-t{font-weight:600}
#d0007-root .ev-m{font-size:11.5px;margin-top:2px}
#d0007-root .why{font-size:11px}
#d0007-root .sw-row{display:inline-flex;gap:3px;margin-top:6px}
#d0007-root .sw{display:inline-block;width:14px;height:14px;border:1px solid #b9c2ba;border-radius:3px;padding:0;cursor:pointer;vertical-align:middle}
#d0007-root .sw.on{outline:2px solid #1f4d2b;outline-offset:1px}
#d0007-root .ed{min-height:20px;border-radius:4px;padding:1px 3px;margin:-1px -3px;cursor:text;white-space:pre-wrap;word-break:break-word;position:relative}
#d0007-root .ed:hover,#d0007-root .ed:focus{background:rgba(31,77,43,.07);outline:none}
#d0007-root .ed input,#d0007-root .ed textarea{width:100%;font:inherit;border:1px solid #1f4d2b;border-radius:4px;padding:2px 4px;background:#fff;resize:vertical}
#d0007-root .ed .edited{display:inline-block;width:6px;height:6px;border-radius:50%;background:#b8860b;margin-left:4px;vertical-align:middle}
#d0007-root .c-notes .ed+.ed,#d0007-root .c-notes .auto{margin-top:4px}
#d0007-root .c-notes .auto{color:#3a4a3d;font-style:italic;white-space:pre-wrap}
#d0007-root .nm{margin-bottom:1px}
#d0007-root .nm .tag{color:#1f4d2b}
#d0007-root .nm .star{color:#b23a2a;margin-left:1px}
#d0007-root .sched-foot{font-size:12px;margin-top:10px}
#d0007-root .sched-foot .sw{width:11px;height:11px;cursor:default}
${['body.d7-print', 'body:has(> #d0007-root:not([style*="none"]))'].map(scope => `
@media print{
  ${scope} > :not(#d0007-root){display:none!important}
  ${scope} #d0007-root{position:static;height:auto;overflow:visible;display:block;background:#fff;font-size:11px}
  ${scope} #d0007-root header,${scope} #d0007-root nav,${scope} #d0007-root footer,${scope} #d0007-root .seg,${scope} #d0007-root .btn,${scope} #d0007-root .sched-flash,${scope} #d0007-root .sw-row,${scope} #d0007-root .sched-foot,${scope} #d0007-root .ev-m,${scope} #d0007-root .edited{display:none!important}
  ${scope} #d0007-root main{overflow:visible;padding:0}
  ${scope} #d0007-root .sched-h:before{content:"Event Schedule — "}
  ${scope} #d0007-root .sched-tbl{max-height:none;overflow:visible;border:0;border-radius:0}
  ${scope} #d0007-root .sched-table{min-width:0;width:100%;table-layout:auto}
  ${scope} #d0007-root .sched-table th,${scope} #d0007-root .sched-table td{position:static;font-size:9.5px;padding:3px 4px;border:1px solid #cfd8d0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  ${scope} #d0007-root .sched-table thead{display:table-header-group}
  ${scope} #d0007-root .sched-table tr{break-inside:avoid;page-break-inside:avoid}
  ${scope} #d0007-root .sched-gap td{height:4px;border:0}
  ${scope} #d0007-root .ed{margin:0;padding:0}
  ${scope} #d0007-root .ed .muted{visibility:hidden}
}`).join('')}
`);
  TABS.push({ id: 'schedule', label: 'Schedule', render: renderSchedule });

  // ---- Roster ----
  async function renderRoster() {
    // Certs decide who's MFR vs Apprentice on the Schedule tab; the roster is
    // where you'd expect to see that, so it's a column here too.
    const [roster, certs] = await Promise.all([VMS.roster(), VMS.certifications().catch(() => [])]);
    const members = Store.all('members');
    const withRole = roster.map(r => { const i = Schedule.memberInfo(r.name, { certs, members }); return { ...r, role: i.role, autoRole: i.autoRole, roleSet: i.roleSet, tags: i.tags, unit: i.unit }; });
    const q = state.q;
    const rows = sortRows(withRole.filter(r => matches(q, r.name, r.email, r.phone, r.contactId, r.status, r.role)), 'roster', 'name');
    const active = roster.filter(r => /active/i.test(r.status)).length;
    const sel = state.rosterSel && withRole.find(r => r.contactId === state.rosterSel);
    const roleCell = r => `${esc(r.role)}${r.tags.length ? ` <b class="tag">${esc(r.tags.join('/'))}</b>` : ''}${r.unit ? ` <span class="muted">(${esc(r.unit)})</span>` : ''}${r.roleSet ? ' <span class="muted" title="Set on this roster, not from certifications">·</span>' : ''}`;
    main.innerHTML = `<div class="wrap">
      <div class="stats"><div class="stat"><b>${roster.length}</b><span>members in group</span></div><div class="stat"><b>${active}</b><span>active</span></div><div class="stat"><b>${roster.length - active}</b><span>other status</span></div><div class="stat"><b>${withRole.filter(r => r.role === 'MFR').length}</b><span>MFR</span></div></div>
      <div class="bar"><input type="search" placeholder="Search name, email, phone, ID…" value="${esc(q)}"><button class="btn" id="d7-csv">Download CSV</button></div>
      <div class="two"><div class="tbl"><table><thead><tr>${th('Name', 'name', 'roster', 'name')}${th('Role', 'role', 'roster', 'name')}${th('Email', 'email', 'roster', 'name')}${th('Phone', 'phone', 'roster', 'name')}${th('Status', 'status', 'roster', 'name')}${th('ID', 'contactId', 'roster', 'name')}</tr></thead><tbody>
        ${rows.map(r => `<tr class="row" data-sel="${esc(r.contactId)}"><td>${esc(r.name)}</td><td>${roleCell(r)}</td><td><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></td><td><a href="tel:${esc(r.phone)}">${esc(r.phone)}</a></td><td>${statusPill(r.status)}</td><td class="muted">${esc(r.contactId)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="side" id="d7-side">${sel ? '<div class="load">Loading…</div>' : '<span class="muted">Select a member to see their hours, certifications and schedule tags.</span>'}</div></div>
    </div>`;
    const inp = main.querySelector('input[type=search]'); inp.addEventListener('input', () => { state.q = inp.value; renderRoster(); });
    bindSort(main, renderRoster);
    main.querySelectorAll('tr[data-sel]').forEach(tr => tr.addEventListener('click', () => { state.rosterSel = tr.dataset.sel; renderRoster(); }));
    main.querySelector('#d7-csv').addEventListener('click', () => downloadCSV('d0007-roster.csv', ['Name', 'Role', 'Tags', 'Unit', 'Email', 'Phone', 'Status', 'Contact ID'], rows.map(r => [r.name, r.role, r.tags.join('/'), r.unit, r.email, r.phone, r.status, r.contactId])));
    if (sel) memberPanel(sel);
  }
  // The bits of a member the schedule needs and VMS has no field for: MFR or
  // Apprentice (when the cert feed is wrong or missing), Command / Driver /
  // Senior, and a home unit for people borrowed from Burlington et al.
  function tagForm(m) {
    const cur = Store.get('members', norm(m.name)) || {};
    const role = cur.role === 'MFR' || cur.role === 'Apprentice' ? cur.role : '';
    const tags = Array.isArray(cur.tags) ? cur.tags : [];
    return `<h4>Schedule tags</h4>
      <form id="d7-tags" class="tagform">
        <label>Role <select name="role"><option value="" ${role ? '' : 'selected'}>Auto (${esc(m.autoRole || '')})</option><option value="MFR" ${role === 'MFR' ? 'selected' : ''}>MFR</option><option value="Apprentice" ${role === 'Apprentice' ? 'selected' : ''}>Apprentice</option></select></label>
        <span class="tagset">${Schedule.TAGS.map(t => `<label><input type="checkbox" name="tag" value="${t}" ${tags.includes(t) ? 'checked' : ''}> ${t}</label>`).join('')}</span>
        <label>Unit <input type="text" name="unit" value="${esc(cur.unit || '')}" placeholder="e.g. Burl" size="8"></label>
      </form>
      <div class="muted" style="font-size:12px">Auto role is ${esc(m.autoRole || '')}${m.autoRole === 'MFR' ? ' (current Medical First Responder cert on file)' : ' (no current Medical First Responder cert in the feed)'}. C = Command, D = Driver, Sr = Senior. Saved in this browser; shows on the Schedule tab as "${esc(m.name)} C/D (Burl)".</div>`;
  }
  function bindTagForm(m) {
    const f = main.querySelector('#d7-tags'); if (!f) return;
    f.addEventListener('submit', e => e.preventDefault());
    f.addEventListener('change', () => {
      // (form.role is the ARIA attribute, not the select - hence querySelector)
      const role = f.querySelector('select[name=role]').value, tags = [...f.querySelectorAll('input[name=tag]:checked')].map(i => i.value), unit = f.querySelector('input[name=unit]').value.trim();
      Store.patch('members', norm(m.name), { role, tags, unit });
      renderRoster();
    });
  }
  async function memberPanel(m) {
    const side = main.querySelector('#d7-side'); if (!side) return;
    try {
      const [hrs, certs] = await Promise.all([VMS.hours(''), VMS.certifications().catch(() => [])]);
      const mine = hrs.filter(h => norm(h.name) === norm(m.name));
      const tot = r2(mine.reduce((a, h) => a + h.completed, 0)), pend = r2(mine.reduce((a, h) => a + h.pending, 0));
      const myCerts = certs.filter(c => norm(c.name) === norm(m.name)).sort((a, b) => (toDate(a.expiry)?.getTime() || 0) - (toDate(b.expiry)?.getTime() || 0));
      side.innerHTML = `<h3>${esc(m.name)}</h3><div class="muted">${esc(m.email)} · ${esc(m.phone)} · ${statusPill(m.status)}</div>
        ${tagForm(m)}
        <h4>Last 12 months</h4><div class="stats" style="margin-bottom:6px"><div class="stat"><b>${tot}</b><span>completed hrs</span></div><div class="stat"><b>${pend}</b><span>pending hrs</span></div><div class="stat"><b>${mine.length}</b><span>events</span></div></div>
        ${mine.length ? `<ul class="plain">${mine.sort((a, b) => b.completed - a.completed).slice(0, 12).map(h => `<li><span>${esc(h.event)}</span><span class="n">${h.completed}${h.pending ? ` <span class="muted">(+${h.pending} pending)</span>` : ''}</span></li>`).join('')}</ul>` : '<div class="muted">No participations in the last 12 months.</div>'}
        <h4>SJA certifications</h4>${myCerts.length ? `<ul class="plain">${myCerts.map(c => `<li><span>${esc(c.qualification)}</span><span>${certPill(c.expiry)}</span></li>`).join('')}</ul>` : '<div class="muted">None on file.</div>'}`;
      bindTagForm(m);
    } catch (e) { side.innerHTML = `<div class="err">${esc(e.message || e)}</div>`; }
  }
  CSS_PARTS.push(`
#d0007-root .tagform{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px;margin-bottom:6px}
#d0007-root .tagform select,#d0007-root .tagform input[type=text]{font:inherit;font-size:13px;border:1px solid #cfd8d0;border-radius:6px;padding:4px 6px;background:#fff}
#d0007-root .tagform .tagset{display:inline-flex;gap:8px}
#d0007-root .tagform .tagset label{white-space:nowrap}
`);
  TABS.push({ id: 'roster', label: 'Roster', render: renderRoster });

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
  TABS.push({ id: 'hours', label: 'Hours', render: renderHours });

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
  TABS.push({ id: 'certs', label: 'Certifications', render: renderCerts });

  // ---- Data ----
  // The unit-side data lives in this browser's localStorage. This is where it
  // gets moved to another browser, or wiped.
  const dataState = { mode: 'merge', confirm: false, msg: '' };
  async function renderData() {
    const counts = { schedule: Object.keys(Store.all('schedule')).length, members: Object.keys(Store.all('members')).length, settings: Object.keys(Store.all('settings')).length };
    main.innerHTML = `<div class="wrap">
      <div class="card"><h3>Local data</h3>
        <p class="muted">${counts.schedule} schedule row${counts.schedule === 1 ? '' : 's'} with edits · ${counts.members} member${counts.members === 1 ? '' : 's'} with tags · ${counts.settings} setting${counts.settings === 1 ? '' : 's'}</p>
        <div class="bar">
          <button class="btn" id="d7-export">Export JSON</button>
          <label class="btn">Import JSON… <input type="file" id="d7-import" accept=".json,application/json" style="display:none"></label>
          <span class="seg"><button data-mode="merge" class="${dataState.mode === 'merge' ? 'on' : ''}" title="Keep what's here, add or overwrite with the file's entries">Merge</button><button data-mode="replace" class="${dataState.mode === 'replace' ? 'on' : ''}" title="Throw away what's here and use the file">Replace</button></span>
        </div>
        ${dataState.msg ? `<div class="muted">${esc(dataState.msg)}</div>` : ''}
      </div>
      <div class="card"><h3>Reset</h3>
        <p class="muted">Clears every schedule edit, member tag and setting from this browser. Nothing in VMS is touched. Export first if there's any chance you'll want it back.</p>
        ${dataState.confirm
          ? `<div class="bar"><span>Really clear it all?</span><button class="btn" id="d7-reset-yes" style="border-color:#c2452f;color:#9a2b1d">Yes, reset local data</button><button class="btn" id="d7-reset-no">Cancel</button></div>`
          : `<button class="btn" id="d7-reset">Reset local data</button>`}
      </div>
      <div class="card"><h3>What lives where</h3>
        <ul style="margin:0;padding-left:18px">
          <li><b>From VMS, read live:</b> events, locations, start dates, sign-ups, shifts (so meet-at-event, approx. end and the names on the schedule), roster, hours, certifications. Refresh re-fetches it.</li>
          <li><b>In this browser only:</b> schedule cells VMS has no field for (Meet @ St.John, coordinator, requirement, notes, equipment, vehicle, row colour, any time you've overridden), and member tags (MFR/Apprentice override, C / D / Sr, home unit). Stored under <code>${esc(Store.KEY)}</code> in localStorage. It doesn't sync anywhere; export and import to pass it to someone else.</li>
        </ul>
      </div>
    </div>`;
    main.querySelector('#d7-export').addEventListener('click', () => {
      const a = el('a', { href: URL.createObjectURL(new Blob([Store.exportJSON()], { type: 'application/json' })), download: `d0007-local-data-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    });
    main.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { dataState.mode = b.dataset.mode; renderData(); }));
    main.querySelector('#d7-import').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = () => { try { Store.importJSON(String(rd.result), { merge: dataState.mode === 'merge' }); dataState.msg = `Imported ${f.name} (${dataState.mode}).`; } catch (err) { dataState.msg = `Couldn't import ${f.name}: ${err.message || err}`; } renderData(); };
      rd.onerror = () => { dataState.msg = `Couldn't read ${f.name}.`; renderData(); };
      rd.readAsText(f);
    });
    const on = (id, fn) => { const b = main.querySelector(id); if (b) b.addEventListener('click', fn); };
    on('#d7-reset', () => { dataState.confirm = true; renderData(); });
    on('#d7-reset-no', () => { dataState.confirm = false; renderData(); });
    on('#d7-reset-yes', () => { Store.reset(); dataState.confirm = false; dataState.msg = 'Local data cleared.'; renderData(); });
  }
  TABS.push({ id: 'data', label: 'Data', render: renderData });

  function downloadCSV(filename, head, rows) {
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
    const a = el('a', { href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })), download: filename }); document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  // --- shell ------------------------------------------------------------
  function addStyles() { if (!document.getElementById('d0007-css')) document.head.appendChild(el('style', { id: 'd0007-css' }, CSS_PARTS.join('\n'))); }
  function open() {
    if (root) { root.style.display = 'flex'; return; }
    addStyles();
    root = el('div', { id: 'd0007-root', role: 'dialog', 'aria-label': APP_TITLE });
    root.innerHTML = `<header><h1>${esc(APP_TITLE)}</h1><span class="sp"></span><button class="btn" id="d7-refresh" title="Re-fetch everything from VMS">Refresh</button><button class="btn" id="d7-close">Close ✕</button></header>
      <nav>${TABS.map(t => `<button data-tab="${t.id}">${esc(t.label)}</button>`).join('')}</nav>
      <main></main>
      <footer>Read-only. Live from your VMS session. Times in Eastern.</footer>`;
    document.body.appendChild(root);
    main = root.querySelector('main');
    root.querySelector('#d7-close').addEventListener('click', close);
    root.querySelector('#d7-refresh').addEventListener('click', () => { VMS.clear(); render(); });
    root.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; state.q = ''; render(); }));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && root && root.style.display !== 'none') close(); });
    render();
  }
  function close() { if (root) root.style.display = 'none'; }

  W.D0007 = Object.assign({ open, close, render, state, version: '0.1.3' }, D);

  // Floating launcher button. Skip it inside iframes (the portal loads entity
  // forms in modals and the script would run there too). Styles go in first -
  // v0.1.1 only added them when the console opened, which left this button
  // unstyled at the bottom of the page. Thanks, Safari, for making me notice.
  if (window.top === window.self && document.body) {
    addStyles();
    const b = el('button', { id: 'd0007-launch', type: 'button', title: APP_TITLE }, 'VMS');
    b.addEventListener('click', open);
    document.body.appendChild(b);
    if (location.hash === '#d0007') open();
  }
  // Second way in, from the Tampermonkey icon menu, in case the button is ever
  // hidden by something on the page.
  if (typeof GM_registerMenuCommand === 'function') {
    try { GM_registerMenuCommand("Open Cam's VMS Console", open); } catch (e) { }
  }
})();
