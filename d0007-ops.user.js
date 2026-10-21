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

  // --- approvals ---------------------------------------------------------
  // The one place this script writes to VMS: approving (or no-showing,
  // cancelling, correcting) the shifts volunteers have reported. In the portal
  // that's Group Lead > Hours, ten rows a page, one modal per shift, three or
  // four clicks each. After a busy weekend it's an evening's work, and most of
  // it is clicking Submit on numbers you've already checked.
  //
  // What the portal does, and what this copies exactly:
  //  - The Hours page renders the pending list as inline JS: one block of
  //    assignments per shift, then a jQuery append into the table. We read the
  //    assignments with a regex. No eval.
  //  - Each shift's Approve link opens an entity form (modal-form-template-path)
  //    over msnfp_participationschedule with start, end, hours and status.
  //    Submit is a WebForms postback of that form. We fill the same four
  //    fields on the same form and submit it the same way, then look for the
  //    same "Submission completed successfully." the portal's modal code looks
  //    for before it closes.
  // Nothing goes near the web api and nothing is guessed about field names: if
  // the form that comes back doesn't have the inputs we expect, or is for a
  // different record, we stop before posting anything.
  const Approvals = (() => {
    const STATUS = { PENDING: '335940000', APPROVED: '335940001', NO_SHOW: '335940002', CANCELLED: '335940003', WAITLIST: '962220001' };
    const STATUS_LABEL = { [STATUS.PENDING]: 'Pending', [STATUS.APPROVED]: 'Shift Hours Approved', [STATUS.NO_SHOW]: 'No Show', [STATUS.CANCELLED]: 'Cancelled', [STATUS.WAITLIST]: 'Waitlist' };
    const FORM_ID = '44862ec7-48ad-ec11-983e-000d3a0a0f70';   // entity form "CS Group Lead - Reported Shift - Approval"
    const PORTAL_ID = '00000000-0000-0000-0000-000000000000'; // yes, really: the portal's own modal code uses the all-zeros id in this path
    const SUCCESS = 'Submission completed successfully.';
    const PAGE_SIZE = 10;
    const FIELDS = ['sjavms_start', 'sjavms_end', 'sjavms_hours', 'msnfp_schedulestatus'];
    const formUrl = shiftId => `/_portal/modal-form-template-path/${PORTAL_ID}?id=${encodeURIComponent(shiftId)}&entityformid=${FORM_ID}`;
    const hoursUrl = (page, search) => `/en-US/group-lead/hours/?groupid=${GROUP_ID}&fetchPage=${page}&fetchSearch=${encodeURIComponent(search || '')}`;

    // Same-origin fetch with the same session check VMS uses. VMS keeps its
    // helpers private and this module has to POST, so it gets its own.
    async function fetchOk(url, opts = {}) {
      const r = await fetch(url, { credentials: 'same-origin', ...opts });
      if (r.redirected && /signin|b2clogin|login/i.test(r.url)) throw new Error('Your VMS session has expired. Sign in to the portal, then press Refresh.');
      if (!r.ok) throw new Error(`${String(url).split('?')[0]} → HTTP ${r.status}`);
      return r;
    }
    const getText = url => fetchOk(url).then(r => r.text());
    const getDoc = url => getText(url).then(t => new DOMParser().parseFromString(t, 'text/html'));

    // --- dates ---
    const pad = n => String(n).padStart(2, '0');
    // CRM wants 2026-07-26T16:00:00.0000000Z: seven fraction digits, UTC.
    function toCrmIso(v) {
      const d = toDate(v); if (!d) throw new Error('Not a date: ' + v);
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.0000000Z`;
    }
    // Safari's Date.parse doesn't like seven fraction digits, so parse by hand.
    function fromCrmIso(s) {
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(String(s ?? '').trim());
      if (!m) return toDate(s);
      let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? Math.round(+('0.' + m[7]) * 1000) : 0);
      if (m[8] && m[8] !== 'Z') { const o = /([+-])(\d{2}):?(\d{2})/.exec(m[8]); ms -= (o[1] === '-' ? -1 : 1) * ((+o[2]) * 60 + (+o[3])) * 60000; }
      return new Date(ms);
    }
    // Eastern wall-clock <-> Date, for datetime-local inputs. The form itself
    // takes UTC; these only exist so the screen can show and take local times.
    const partsIn = d => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d).filter(p => p.type !== 'literal').map(p => [p.type, +p.value]));
    function toLocalInput(v) { const d = toDate(v); if (!d) return ''; const p = partsIn(d); return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`; }
    function fromLocalInput(s) {
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s ?? '').trim()); if (!m) return null;
      const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
      const off = d => { const p = partsIn(d); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(d.getTime() / 1000) * 1000; };
      // two passes so the DST changeover days come out right
      let d = new Date(wall - off(new Date(wall)));
      d = new Date(wall - off(d));
      return d;
    }

    // --- the pending list ---
    // One block per shift in the page's inline script, like:
    //   shiftId = "guid"; origStartDate = "Sun, 26 Jul 2026 16:00:00 GMT";
    //   volunteerName = "..."; eventName = "..."; actionButton = ...;
    //   $("#pendingShiftsTable").append("<tr><td>" + volunteerName + ... + startDateInEST + "</td><td>5</td> ...
    // The hours only exist as that literal <td> in the append, so read it from there.
    const unq = s => s.replace(/\\(.)/g, '$1');
    function parseHoursPage(html) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const scripts = [...doc.querySelectorAll('script:not([src])')].map(s => s.textContent).filter(s => /totalRecordCount|\bshiftId\s*=/.test(s)).sort((a, b) => b.length - a.length);
      const js = scripts[0] || '';
      const total = +((/var\s+totalRecordCount\s*=\s*(\d+)/.exec(js) || [])[1] || 0);
      const items = [];
      for (const block of js.split(/(?=\bshiftId\s*=\s*")/)) {
        const get = name => { const m = new RegExp('\\b' + name + '\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"').exec(block); return m ? unq(m[1]) : ''; };
        const shiftId = get('shiftId'); if (!shiftId) continue;
        const h = /startDateInEST\s*\+\s*"<\/td><td>([^<]*)<\/td>/.exec(block);
        items.push({ shiftId, start: toDate(get('origStartDate')), name: decodeEntities(get('volunteerName')), event: decodeEntities(get('eventName')), hours: num(h ? h[1] : '') });
      }
      return { total, items };
    }

    // Walks the Hours pages. Page 1 says how many records there are; the rest
    // go four at a time. onPage gets { loaded, total, pages, truncated } as
    // pages land, for a progress line.
    async function pending({ search = '', maxPages = 50, onPage } = {}) {
      const first = parseHoursPage(await getText(hoursUrl(1, search)));
      const total = Math.max(first.total, first.items.length);
      const pages = Math.max(1, Math.min(maxPages, Math.ceil(total / PAGE_SIZE)));
      const byPage = [first.items];
      let loaded = first.items.length;
      const report = () => { if (onPage) onPage({ loaded, total, pages, truncated: pages * PAGE_SIZE < total }); };
      report();
      const queue = []; for (let p = 2; p <= pages; p++) queue.push(p);
      const worker = async () => { for (let p; (p = queue.shift());) { const got = parseHoursPage(await getText(hoursUrl(p, search))).items; byPage[p - 1] = got; loaded += got.length; report(); } };
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
      const seen = new Set(), out = [];
      for (const it of byPage.flat()) { if (!it || seen.has(it.shiftId)) continue; seen.add(it.shiftId); out.push(it); }
      out.sort((a, b) => norm(a.event).localeCompare(norm(b.event)) || ((a.start?.getTime() || 0) - (b.start?.getTime() || 0)) || norm(a.name).localeCompare(norm(b.name)));
      return out;
    }

    // --- the approval form ---
    // Refuses to go further unless the page is the form we expect, for the
    // record we asked for. Cheap insurance against VMS changing the form
    // under us and this script posting into the wrong thing.
    function checkForm(doc, shiftId) {
      const idInput = doc.getElementById('EntityFormControl_EntityFormView_EntityID');
      if (idInput && norm(idInput.value) !== norm(shiftId)) throw new Error(`The form that loaded is for a different record (${idInput.value}), not ${shiftId}. Not posting.`);
      const ent = doc.getElementById('EntityFormControl_EntityFormView_EntityName');
      if (ent && ent.value !== 'msnfp_participationschedule') throw new Error(`Expected a participation-schedule form, got "${ent.value}". Not posting.`);
      for (const id of FIELDS) if (!doc.getElementById(id)) throw new Error(`The approval form has no #${id} field. VMS may have changed the form; not posting.`);
      const btn = doc.getElementById('UpdateButton');
      if (!btn || !btn.getAttribute('name')) throw new Error('The approval form has no Submit button; not posting.');
      const form = btn.form || doc.getElementById('content_form') || doc.querySelector('form');
      if (!form) throw new Error('The approval page has no form; not posting.');
      return { form, btn };
    }
    function readForm(doc, shiftId) {
      checkForm(doc, shiftId);
      const v = id => doc.getElementById(id)?.value ?? '';
      const sel = doc.getElementById('msnfp_schedulestatus');
      const statusOptions = [...sel.options].filter(o => o.value).map(o => ({ value: o.value, label: o.textContent.trim() }));
      const status = sel.value || (sel.querySelector('option[selected]')?.value ?? '');
      return { shiftId, participation: v('msnfp_participationid_name'), scheduleName: v('msnfp_engagementopportunityscheduleid_name'), start: fromCrmIso(v('sjavms_start')), end: fromCrmIso(v('sjavms_end')), hours: num(v('sjavms_hours')), status, statusOptions };
    }
    const loadForm = async shiftId => readForm(await getDoc(formUrl(shiftId)), shiftId);

    // Pure. Works out what the four fields should be from the loaded form plus
    // whatever changed, and refuses the combinations VMS would reject or that
    // are obviously wrong. The screen calls this on every edit so the row
    // always shows exactly what would be sent.
    function plan(form, changes = {}) {
      const status = String(changes.status ?? form.status ?? STATUS.PENDING);
      if (!STATUS_LABEL[status]) throw new Error(`"${status}" is not a shift status VMS knows`);
      const start = toDate(changes.start ?? form.start);
      if (!start) throw new Error('Shift start is not a valid date');
      const given = x => x !== undefined && x !== null && x !== '';
      let hours = given(changes.hours) ? Number(changes.hours) : null;
      let end = given(changes.end) ? toDate(changes.end) : null;
      if (hours !== null && !isFinite(hours)) throw new Error('Hours must be a number');
      if (given(changes.end) && !end) throw new Error('Shift end is not a valid date');
      if (hours !== null && hours < 0) throw new Error('Hours can\'t be negative');
      if (hours === null && end === null) {
        // Nothing about the length changed: keep the form's hours, and its end
        // too unless the start moved (then the whole shift moves).
        hours = Number(form.hours) || 0;
        const fs = toDate(form.start);
        if (fs && fs.getTime() === start.getTime()) end = toDate(form.end);
      }
      if (end === null) end = new Date(start.getTime() + hours * 3600000);
      else if (hours === null) hours = (end.getTime() - start.getTime()) / 3600000;
      hours = r2(hours);
      if (end.getTime() < start.getTime()) throw new Error('Shift end is before its start');
      if (hours > 24) throw new Error(`${hours} hours is more than a day; check the times or split the shift`);
      if (status === STATUS.APPROVED && !(hours > 0)) throw new Error('Approving a shift needs more than zero hours');
      return { start, end, hours, status };
    }

    // --- submitting ---
    // Sets the four inputs on a (parsed or live) form document and fires
    // change on each, the way a person's edits would. Throws if the status
    // isn't one of the form's options.
    function fillForm(doc, fields) {
      for (const [id, val] of Object.entries(fields)) {
        const n = doc.getElementById(id);
        n.value = val;
        if (n.tagName === 'SELECT' && n.value !== val) throw new Error(`Status ${val} is not an option on this form`);
        const ev = doc.createEvent('Event'); ev.initEvent('change', true, true); n.dispatchEvent(ev);
      }
    }
    // What the portal's modal checks for after the postback, and what we check.
    function readResult(doc) {
      const msg = (doc.getElementById('MessageLabel')?.textContent || '').trim();
      if (msg === SUCCESS) return { ok: true };
      const clean = n => n.textContent.replace(/\s+/g, ' ').trim();
      let errs = [...doc.querySelectorAll('.validation-summary li')].map(clean).filter(Boolean);
      if (!errs.length) errs = [...doc.querySelectorAll('.alert-danger')].map(clean).filter(Boolean);
      errs = [...new Set(errs)];
      throw new Error(errs.length ? errs.join('; ') : msg ? `VMS said: ${msg}` : 'VMS did not confirm the update (no success message came back). Reload before trying again.');
    }
    function fieldsFor(values) {
      const v = plan({ start: values.start, end: values.end, hours: values.hours, status: values.status }, { status: values.status });
      return { sjavms_start: toCrmIso(v.start), sjavms_end: toCrmIso(v.end), sjavms_hours: v.hours.toFixed(2), msnfp_schedulestatus: v.status };
    }

    // Production driver. A hidden same-origin iframe loads the real form, so
    // the portal's own scripts (date pickers, client validators, the WebForms
    // postback) all run as they would in the modal. Sequence:
    //   1. iframe <- GET modal form
    //   2. on load: sanity-check the form, set the four fields, fire change
    //   3. click #UpdateButton (its onclick validates then posts back);
    //      if the postback script isn't there, set __EVENTTARGET and form.submit()
    //   4. shortly after: if the page's validators said no, bail with their text
    //   5. on the next load: #MessageLabel == success, else collect the errors
    //   6. always remove the iframe; 45 s without an answer is a failure
    function iframeDriver(shiftId, fields, { timeout = 45000 } = {}) {
      return new Promise((resolve, reject) => {
        const f = document.createElement('iframe');
        f.style.display = 'none'; f.setAttribute('aria-hidden', 'true'); f.setAttribute('title', 'VMS approval form');
        let phase = 'form', settled = false;
        const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); try { f.remove(); } catch (e) { /* already gone */ } fn(v); };
        const timer = setTimeout(() => finish(reject, new Error(`VMS took more than ${Math.round(timeout / 1000)} s to answer. The shift may or may not have been updated; reload the list before trying again.`)), timeout);
        f.addEventListener('load', () => {
          try {
            const doc = f.contentDocument, w = f.contentWindow;
            if (!doc || !w) throw new Error('Could not read the approval form.');
            if (/signin|b2clogin|login/i.test(w.location.href)) throw new Error('Your VMS session has expired. Sign in to the portal, then press Refresh.');
            if (phase === 'result') { finish(resolve, readResult(doc)); return; }
            phase = 'result';
            const { form, btn } = checkForm(doc, shiftId);
            fillForm(doc, fields);
            if (typeof w.WebForm_DoPostBackWithOptions === 'function' && btn.getAttribute('onclick')) btn.click();
            else {
              const set = (name, val) => { let i = form.querySelector(`input[name="${name}"]`); if (!i) { i = doc.createElement('input'); i.type = 'hidden'; i.name = name; form.appendChild(i); } i.value = val; };
              set('__EVENTTARGET', btn.getAttribute('name')); set('__EVENTARGUMENT', '');
              form.submit();
            }
            // If the page's own validators rejected the values there's no
            // postback and we'd sit here until the timeout. Look for that.
            setTimeout(() => {
              if (settled) return;
              const bad = [...doc.querySelectorAll('.validation-summary li')].map(n => n.textContent.trim()).filter(Boolean);
              if (w.Page_IsValid === false || bad.length) finish(reject, new Error(bad.join('; ') || 'The form\'s own validation rejected the values.'));
            }, 800);
          } catch (e) { finish(reject, e); }
        });
        f.src = formUrl(shiftId);
        document.body.appendChild(f);
      });
    }

    // Same postback, by hand: GET the form, serialise every input (viewstate,
    // event validation, the honeypot, all of it), apply our four values, name
    // the Submit button as the event target, POST to the form's action. This
    // is what the tests use (jsdom can't run the iframe round trip); it's
    // also a fallback if the iframe route ever stops working.
    async function fetchDriver(shiftId, fields) {
      const url = formUrl(shiftId);
      const doc = await getDoc(url);
      const { form, btn } = checkForm(doc, shiftId);
      fillForm(doc, fields);
      const body = new URLSearchParams();
      for (const n of form.querySelectorAll('input, select, textarea')) {
        if (!n.name) continue;
        const type = (n.getAttribute('type') || n.tagName).toLowerCase();
        if (['button', 'submit', 'reset', 'image', 'file'].includes(type)) continue;
        if ((type === 'checkbox' || type === 'radio') && !n.checked) continue;
        body.append(n.name, n.value ?? '');
      }
      body.set('__EVENTTARGET', btn.getAttribute('name'));
      body.set('__EVENTARGUMENT', '');
      const r = await fetchOk(form.getAttribute('action') || url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
      return readResult(new DOMParser().parseFromString(await r.text(), 'text/html'));
    }
    const drivers = { iframe: iframeDriver, fetch: fetchDriver };

    // values: { start, end, hours, status } (what plan() returns).
    // Resolves { ok: true } or rejects with the portal's own message.
    async function submit(shiftId, values, { driver, timeout } = {}) {
      if (!shiftId) throw new Error('No shift id');
      const fields = fieldsFor(values);
      const drv = typeof driver === 'function' ? driver : drivers[driver || api.defaultDriver] || drivers.iframe;
      return drv(shiftId, fields, { timeout });
    }

    // Sequential on purpose: one shift at a time, the way a person does it,
    // and so a failure is attributable. items: [{ shiftId, values, ...rest }].
    async function run(items, { driver, onProgress, stopOnError = false } = {}) {
      const done = [], failed = [];
      try {
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          let result;
          try { result = await submit(it.shiftId, it.values, { driver }); done.push({ ...it, result }); }
          catch (e) { result = { ok: false, error: e.message || String(e) }; failed.push({ ...it, error: result.error }); }
          if (onProgress) onProgress(i, result, it);
          if (!result.ok && stopOnError) break;
        }
      } finally {
        // Hours and event detail are now stale whatever happened.
        VMS.clear();
      }
      return { done, failed };
    }

    const api = { STATUS, STATUS_LABEL, FORM_ID, SUCCESS, formUrl, hoursUrl, parseHoursPage, pending, loadForm, plan, submit, run, toCrmIso, fromCrmIso, toLocalInput, fromLocalInput, readResult, drivers, defaultDriver: 'iframe' };
    return api;
  })();
  D.Approvals = Approvals;

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
      const title = box.closest('.card')?.querySelector('h3')?.textContent || '';
      const byStatus = {}; d.participants.forEach(p => { byStatus[p.status || '—'] = (byStatus[p.status || '—'] || 0) + 1; });
      box.innerHTML = `
        ${d.description ? `<p class="muted" style="margin:0 0 8px">${esc(d.description)}</p>` : ''}
        <div class="bar"><b>Sign-ups (${d.participants.length})</b> ${Object.entries(byStatus).map(([k, v]) => statusPill(`${k}: ${v}`)).join(' ')}</div>
        ${d.participants.length ? `<div class="tbl"><table><thead><tr><th>Volunteer</th><th>Status</th><th>Signed up</th><th class="n">Hours</th><th class="n">Pending</th></tr></thead><tbody>
          ${d.participants.map(p => `<tr><td>${esc(p.name)}</td><td>${statusPill(p.status)}</td><td>${esc(fmtD(p.signedUp))}</td><td class="n">${p.hours || ''}</td><td class="n">${p.pendingHours || ''}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="muted">Nobody has signed up yet.</div>'}
        ${d.shifts.length ? `<div class="bar" style="margin-top:12px"><b>Reported shifts (${d.shifts.length})</b></div><div class="tbl"><table><thead><tr><th>Volunteer</th><th>Start</th><th class="n">Hours</th><th>Status</th></tr></thead><tbody>
          ${d.shifts.map(s => `<tr><td>${esc(s.name)}</td><td>${esc(fmtDT(s.start))}</td><td class="n">${s.hours || ''}</td><td>${statusPill(s.status)}${/pending/i.test(s.status) ? ` <button class="btn ap-go" data-approve="${esc(title)}" title="Open this event's pending shifts on the Hours tab">Approve…</button>` : ''}</td></tr>`).join('')}
        </tbody></table></div>` : ''}`;
      // Pending rows jump to the Hours tab filtered to this event, so approvals
      // can be done event by event from here.
      box.querySelectorAll('[data-approve]').forEach(b => b.addEventListener('click', () => { state.pendingSearch = b.dataset.approve; state.tab = 'hours'; state.q = ''; render(); }));
    } catch (e) { box.innerHTML = `<div class="err">${esc(e.message || e)}</div>`; }
  }
  const CSS_ID = s => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  TABS.push({ id: 'events', label: 'Events', render: renderEvents });

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
  TABS.push({ id: 'roster', label: 'Roster', render: renderRoster });

  // ---- Hours ----
  // Two things on this tab. The top is the pending-approval queue, which is
  // the one place this script writes to VMS (the mechanics are in
  // 22-approve.js). Below it, collapsed, is the hours report that used to be
  // the whole tab.
  //
  // Nothing is written until the person presses Submit, reads the list of
  // exactly what will change, and presses Confirm. Each row's start/end/hours
  // come from the shift's own approval form (read when the row is first
  // touched), not from the list page, so what's shown is what gets sent.
  const AP = { list: null, total: 0, truncated: false, progress: '', error: null, rows: new Map(), closed: new Set(), confirm: null, running: null, lastRun: null, reportOpen: false, loadToken: 0, evHours: {}, reportRows: [] };
  const AP_STATUSES = [[Approvals.STATUS.APPROVED, 'Approve'], [Approvals.STATUS.NO_SHOW, 'No show'], [Approvals.STATUS.CANCELLED, 'Cancel'], [Approvals.STATUS.PENDING, 'Leave pending']];
  const AP_SPIN = ' <span class="ap-spin" title="Reading the shift from VMS…"></span>';

  const apRow = item => ({ id: item.shiftId, item, form: null, formLoading: false, formError: null, formPromise: null, sel: false, status: Approvals.STATUS.APPROVED, edits: {}, timesOpen: false, result: null });
  // Until the form has been read, the list page's start and hours stand in.
  const apBase = r => r.form || { start: r.item.start, end: r.item.start ? new Date(r.item.start.getTime() + r.item.hours * 3600000) : null, hours: r.item.hours, status: Approvals.STATUS.PENDING };
  function apView(r) { try { return { v: Approvals.plan(apBase(r), { ...r.edits, status: r.status }), err: null }; } catch (e) { return { v: null, err: e.message || String(e) }; } }
  const apShown = r => { const { v, err } = apView(r); const b = apBase(r); return { start: v ? v.start : (r.edits.start || b.start), end: v ? v.end : (r.edits.end || b.end), hours: v ? v.hours : (r.edits.hours ?? b.hours), err }; };
  function apMsg(r, err) {
    if (r.formError) return 'Couldn\'t read the shift form: ' + r.formError;
    if (r.form && r.form.status !== Approvals.STATUS.PENDING) return `VMS now has this shift as ${Approvals.STATUS_LABEL[r.form.status] || r.form.status}, not Pending. Reload the list.`;
    if (err) return err;
    if (r.result && !r.result.ok) return r.result.error;
    return '';
  }
  const apSelected = () => [...AP.rows.values()].filter(r => r.sel);
  const apBusy = () => !!(AP.confirm || AP.running);

  // Entry from the tab bar or Refresh: start over.
  async function renderHours() {
    Object.assign(AP, { list: null, error: null, confirm: null, running: null, rows: new Map(), progress: '' });
    await apLoad();
  }
  // keepRows keeps selections, edits and results for shifts still pending
  // (used after a run and by Reload); quiet leaves the current list on screen
  // while the new one comes in.
  async function apLoad({ keepRows = false, quiet = false } = {}) {
    const token = ++AP.loadToken;
    const prev = AP.rows;
    AP.error = null; AP.progress = 'Loading pending shifts…';
    if (!quiet) { AP.list = null; AP.rows = new Map(); }
    await paintHours();
    try {
      const list = await Approvals.pending({ onPage: p => {
        if (token !== AP.loadToken) return;
        AP.total = p.total; AP.truncated = p.truncated; AP.progress = `Loaded ${p.loaded} of ${p.total}…`;
        const n = main.querySelector('#ap-progress'); if (n) n.textContent = AP.progress;
      } });
      if (token !== AP.loadToken) return;
      AP.list = list; AP.rows = new Map(); AP.progress = '';
      // (a form read still in flight belongs to the old row object; the new one just reads again when touched)
      for (const it of list) { const old = keepRows && prev.get(it.shiftId); AP.rows.set(it.shiftId, old ? { ...old, item: it, formLoading: false, formPromise: null } : apRow(it)); }
    } catch (e) { if (token !== AP.loadToken) return; AP.error = e.message || String(e); AP.progress = ''; }
    await paintHours();
  }

  // --- the shift form, read lazily, three at a time ---
  const apQueue = []; let apInFlight = 0;
  function apPump() { while (apInFlight < 3 && apQueue.length) { apInFlight++; apQueue.shift()().finally(() => { apInFlight--; apPump(); }); } }
  function apEnsureForm(r) {
    if (r.form) return Promise.resolve(r.form);
    if (r.formLoading) return r.formPromise;
    r.formLoading = true; r.formError = null; apRowDom(r);
    r.formPromise = new Promise(resolve => apQueue.push(() => Approvals.loadForm(r.id)
      .then(f => { r.form = f; }, e => { r.formError = e.message || String(e); })
      .then(() => { r.formLoading = false; apRowDom(r); resolve(r.form); })));
    apPump();
    return r.formPromise;
  }

  // --- painting ---
  async function paintHours() {
    if (state.tab !== 'hours' || !main) return;
    let report = '';
    if (AP.reportOpen) { try { report = await hoursReportHTML(); } catch (e) { report = `<div class="err">${esc(e.message || e)}</div>`; } }
    if (state.tab !== 'hours') return;
    main.innerHTML = `<div class="wrap">
      <div class="bar"><h2 class="ap-h">Pending approvals${AP.list ? ` <span class="pill amber">${AP.list.length}</span>` : ''}</h2><span class="sp"></span>
        <input type="search" id="ap-q" placeholder="Filter by volunteer or event…" value="${esc(state.pendingSearch || '')}" ${AP.list ? '' : 'disabled'}>
        <button class="btn" id="ap-reload" title="Re-read the pending list from VMS (keeps your edits)" ${apBusy() ? 'disabled' : ''}>Reload</button></div>
      ${AP.error ? `<div class="err"><b>Couldn't load the pending list.</b> ${esc(AP.error)}</div>` : ''}
      ${AP.list ? `<div class="muted ap-progress" id="ap-progress">${esc(AP.progress)}</div>` : AP.error ? '' : `<div class="load" id="ap-progress">${esc(AP.progress || 'Loading pending shifts…')}</div>`}
      ${AP.truncated ? `<div class="err">VMS has ${AP.total} pending shifts and this shows the first ${AP.list ? AP.list.length : ''}. Approve some and reload for the rest.</div>` : ''}
      ${apLastRunHTML()}
      ${apConfirmHTML()}
      <div id="ap-groups">${AP.list ? apGroupsHTML() : ''}</div>
      ${AP.list ? apActionsHTML() : ''}
      <div class="card ap-report">
        <div class="bar" style="margin:0"><button class="btn" id="ap-report-tog">${AP.reportOpen ? 'Hide hours report' : 'Hours report ▸'}</button><span class="muted">Completed and pending hours by volunteer or by event, from Reports → Volunteer Hours.</span></div>
        ${AP.reportOpen ? report : ''}
      </div>
    </div>`;
    bindApprovals();
    if (AP.reportOpen) bindHoursReport();
  }
  function apGroupsHTML() {
    const q = state.pendingSearch || '';
    const rows = [...AP.rows.values()].filter(r => matches(q, r.item.name, r.item.event));
    if (!rows.length) return `<div class="card muted">${AP.rows.size ? 'Nothing matches that filter.' : 'Nothing is waiting for approval.'}</div>`;
    const groups = new Map();
    for (const r of rows) {
      const k = r.item.event || '—';
      if (!groups.has(k)) groups.set(k, { event: k, rows: [], latest: 0 });
      const g = groups.get(k); g.rows.push(r); g.latest = Math.max(g.latest, r.item.start?.getTime() || 0);
    }
    AP.groups = [...groups.values()].sort((a, b) => b.latest - a.latest);
    AP.groups.forEach(g => g.rows.sort((a, b) => ((a.item.start?.getTime() || 0) - (b.item.start?.getTime() || 0)) || norm(a.item.name).localeCompare(norm(b.item.name))));
    const dis = apBusy() ? 'disabled' : '';
    return AP.groups.map((g, i) => apGroupHTML(g, i, dis)).join('');
  }
  function apGroupHTML(g, i, dis) {
    const closed = AP.closed.has(g.event);
    const nSel = g.rows.filter(r => r.sel).length;
    return `<div class="card ap-group" data-g="${i}">
      <div class="ap-ghead">
        <button class="ap-tog" data-tog="${i}" aria-expanded="${!closed}" title="${closed ? 'Show' : 'Hide'} shifts">${closed ? '▸' : '▾'}</button>
        <div class="ap-gtitle"><b>${esc(g.event)}</b><span class="muted">${esc(fmtD(new Date(g.latest)))} · ${g.rows.length} shift${g.rows.length === 1 ? '' : 's'} · <span data-gsel="${i}">${nSel}</span> selected</span></div>
        <span class="sp"></span>
        <label class="ap-evh">Set hours for all <input type="number" step="0.25" min="0" data-evh="${i}" value="${esc(AP.evHours[g.event] ?? '')}" ${dis}> <button class="btn" data-evh-apply="${i}" ${dis}>Apply</button></label>
        <button class="btn" data-selall="${i}" ${dis}>${nSel === g.rows.length ? 'Select none' : 'Select all'}</button>
        <button class="btn" data-approveall="${i}" ${dis} title="Select every shift here, hours as the volunteers reported them, status Approve">Approve all as reported</button>
      </div>
      ${closed ? '' : `<div class="tbl ap-tbl"><table><thead><tr><th></th><th>Volunteer</th><th>Start</th><th>End</th><th class="n">Hours</th><th>Action</th><th></th></tr></thead><tbody>${g.rows.map(r => apRowHTML(r, dis)).join('')}</tbody></table></div>`}
    </div>`;
  }
  const apMark = r => !r.result ? '' : r.result.ok ? '<span class="ap-ok" title="Updated in VMS">✓</span>' : `<span class="ap-bad" title="${esc(r.result.error)}">✗</span>`;
  function apRowHTML(r, dis) {
    const s = apShown(r);
    return `<tr class="ap-row${r.sel ? ' sel' : ''}" data-id="${esc(r.id)}">
      <td><input type="checkbox" data-sel ${r.sel ? 'checked' : ''} ${dis}></td>
      <td><div class="ap-name">${apMark(r)}${esc(r.item.name)}${r.formLoading ? AP_SPIN : ''}</div><div class="muted ap-sub">${esc(r.form ? r.form.scheduleName : '')}</div><div class="ap-msg">${esc(apMsg(r, s.err))}</div></td>
      <td class="ap-start">${esc(fmtDT(s.start))}</td>
      <td class="ap-end">${esc(fmtDT(s.end))}</td>
      <td class="n"><input type="number" step="0.25" min="0" data-hours value="${esc(s.hours)}" ${dis}></td>
      <td><select data-status ${dis}>${AP_STATUSES.map(([v, l]) => `<option value="${v}" ${r.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td><button class="lnk" data-times ${dis}>${r.timesOpen ? 'hide times' : 'edit times'}</button></td>
    </tr>
    <tr class="ap-times" data-times-for="${esc(r.id)}" ${r.timesOpen ? '' : 'hidden'}><td></td><td colspan="6">
      <label>Start <input type="datetime-local" data-start value="${esc(Approvals.toLocalInput(s.start))}" ${dis}></label>
      <label>End <input type="datetime-local" data-end value="${esc(Approvals.toLocalInput(s.end))}" ${dis}></label>
      <span class="muted">Eastern. Changing the end recalculates hours; changing hours recalculates the end.</span></td></tr>`;
  }
  function apActionsHTML() {
    const n = apSelected().length;
    return `<div class="ap-actions" id="ap-actions"><b id="ap-count">${n} selected</b><span class="sp"></span>
      <button class="btn" id="ap-clear" ${n && !apBusy() ? '' : 'disabled'}>Clear selection</button>
      <button class="btn primary" id="ap-submit" ${n && !apBusy() ? '' : 'disabled'}>Submit ${n} change${n === 1 ? '' : 's'}</button></div>`;
  }
  function apChangeLine(name, event, p, form) {
    const moved = form && (p.start.getTime() !== form.start?.getTime() || p.end.getTime() !== form.end?.getTime());
    return `${esc(name)} — ${esc(event)} — ${p.hours.toFixed(2)} h${moved ? ` (${esc(fmtDT(p.start))} – ${esc(fmtT(p.end))})` : ''} → ${esc(Approvals.STATUS_LABEL[p.status])}`;
  }
  function apConfirmHTML() {
    if (AP.running) {
      const { i, n } = AP.running;
      return `<div class="card ap-confirm" id="ap-run"><h3>Writing to VMS…</h3><div class="staff"><span class="ap-run-n">${i} of ${n}</span><div class="track"><i style="width:${n ? Math.round(100 * i / n) : 0}%"></i></div></div><p class="muted">One shift at a time. Leave this tab open until it finishes.</p></div>`;
    }
    if (!AP.confirm) return '';
    if (AP.confirm.loading) return `<div class="card ap-confirm"><h3>Checking the shifts…</h3><div class="load">Reading each shift's approval form from VMS so the list below is exactly what will be sent.</div></div>`;
    const ok = AP.confirm.items.filter(i => i.plan && !i.noop), skipped = AP.confirm.items.filter(i => !i.plan || i.noop);
    return `<div class="card ap-confirm">
      <h3>Write ${ok.length} change${ok.length === 1 ? '' : 's'} to VMS?</h3>
      ${ok.length ? `<ul class="plain">${ok.map(i => `<li><span>${apChangeLine(i.r.item.name, i.r.item.event, i.plan, i.r.form)}</span></li>`).join('')}</ul>` : ''}
      ${skipped.length ? `<div class="muted" style="margin-bottom:6px">Not being sent:</div><ul class="plain">${skipped.map(i => `<li><span>${esc(i.r.item.name)} — ${esc(i.r.item.event)}</span><span class="pill ${i.noop ? 'grey' : 'red'}">${esc(i.noop ? 'no change' : i.err)}</span></li>`).join('')}</ul>` : ''}
      <p>Confirm sends each of these to VMS as you, one at a time, through the same approval form the Hours page uses. A shift approved here can't be put back to pending from this screen.</p>
      <div class="bar" style="margin:0"><button class="btn primary" id="ap-confirm" ${ok.length ? '' : 'disabled'}>Confirm</button><button class="btn" id="ap-cancel">Cancel</button></div>
    </div>`;
  }
  function apLastRunHTML() {
    const l = AP.lastRun; if (!l) return '';
    return `<div class="card ap-last"><div class="bar" style="margin:0 0 6px"><b>Last run: ${l.done.length} updated, ${l.failed.length} failed</b><span class="muted">${esc(fmtDT(l.at))}</span><span class="sp"></span><button class="btn" id="ap-last-close">Dismiss</button></div>
      <ul class="plain">${l.done.map(d => `<li><span class="ap-ok">✓</span><span>${apChangeLine(d.name, d.event, d.values, null)}</span></li>`).join('')}${l.failed.map(f => `<li><span class="ap-bad">✗</span><span>${esc(f.name)} — ${esc(f.event)}</span><span class="pill red">${esc(f.error)}</span></li>`).join('')}</ul></div>`;
  }

  // In-place updates so typing in one row doesn't repaint the screen.
  function apRowDom(r, { keepHours = false } = {}) {
    const tr = main && main.querySelector(`tr.ap-row[data-id="${r.id}"]`); if (!tr) return;
    const s = apShown(r);
    tr.classList.toggle('sel', r.sel);
    tr.querySelector('[data-sel]').checked = r.sel;
    tr.querySelector('.ap-start').textContent = fmtDT(s.start);
    tr.querySelector('.ap-end').textContent = fmtDT(s.end);
    if (!keepHours) tr.querySelector('[data-hours]').value = s.hours;
    tr.querySelector('[data-status]').value = r.status;
    tr.querySelector('.ap-name').innerHTML = `${apMark(r)}${esc(r.item.name)}${r.formLoading ? AP_SPIN : ''}`;
    tr.querySelector('.ap-sub').textContent = r.form ? r.form.scheduleName : '';
    tr.querySelector('.ap-msg').textContent = apMsg(r, s.err);
    tr.querySelector('[data-times]').textContent = r.timesOpen ? 'hide times' : 'edit times';
    const tt = main.querySelector(`tr.ap-times[data-times-for="${r.id}"]`);
    if (tt) { tt.hidden = !r.timesOpen; tt.querySelector('[data-start]').value = Approvals.toLocalInput(s.start); tt.querySelector('[data-end]').value = Approvals.toLocalInput(s.end); }
  }
  function apCounts() {
    const n = apSelected().length;
    const c = main.querySelector('#ap-count'); if (c) c.textContent = `${n} selected`;
    const b = main.querySelector('#ap-submit'); if (b) { b.textContent = `Submit ${n} change${n === 1 ? '' : 's'}`; b.disabled = !n || apBusy(); }
    const cl = main.querySelector('#ap-clear'); if (cl) cl.disabled = !n || apBusy();
    (AP.groups || []).forEach((g, i) => { const k = g.rows.filter(r => r.sel).length; const s = main.querySelector(`[data-gsel="${i}"]`); if (s) s.textContent = k; const sa = main.querySelector(`[data-selall="${i}"]`); if (sa) sa.textContent = k === g.rows.length ? 'Select none' : 'Select all'; });
  }
  function apTouch(r) { r.sel = true; apEnsureForm(r); }

  function bindApprovals() {
    const q = main.querySelector('#ap-q');
    if (q) q.addEventListener('input', () => { state.pendingSearch = q.value; const g = main.querySelector('#ap-groups'); if (g) { g.innerHTML = apGroupsHTML(); bindGroups(); apCounts(); } });
    main.querySelector('#ap-reload')?.addEventListener('click', () => apLoad({ keepRows: true, quiet: true }));
    main.querySelector('#ap-report-tog')?.addEventListener('click', () => { AP.reportOpen = !AP.reportOpen; paintHours(); });
    main.querySelector('#ap-last-close')?.addEventListener('click', () => { AP.lastRun = null; paintHours(); });
    main.querySelector('#ap-submit')?.addEventListener('click', apBeginConfirm);
    main.querySelector('#ap-clear')?.addEventListener('click', () => { AP.rows.forEach(r => { r.sel = false; }); main.querySelector('#ap-groups').innerHTML = apGroupsHTML(); bindGroups(); apCounts(); });
    main.querySelector('#ap-confirm')?.addEventListener('click', apRun);
    main.querySelector('#ap-cancel')?.addEventListener('click', () => { AP.confirm = null; paintHours(); });
    bindGroups();
  }
  function bindGroups() {
    const g = main.querySelector('#ap-groups'); if (!g) return;
    const repaint = () => { g.innerHTML = apGroupsHTML(); bindGroups(); apCounts(); };
    g.querySelectorAll('[data-tog]').forEach(b => b.addEventListener('click', () => { const ev = AP.groups[+b.dataset.tog].event; if (AP.closed.has(ev)) AP.closed.delete(ev); else AP.closed.add(ev); repaint(); }));
    g.querySelectorAll('[data-selall]').forEach(b => b.addEventListener('click', () => { const grp = AP.groups[+b.dataset.selall]; const all = grp.rows.every(r => r.sel); grp.rows.forEach(r => { r.sel = !all; if (!all) apEnsureForm(r); }); repaint(); }));
    g.querySelectorAll('[data-approveall]').forEach(b => b.addEventListener('click', () => { const grp = AP.groups[+b.dataset.approveall]; grp.rows.forEach(r => { r.sel = true; r.status = Approvals.STATUS.APPROVED; r.edits = {}; apEnsureForm(r); }); repaint(); }));
    g.querySelectorAll('[data-evh]').forEach(inp => inp.addEventListener('input', () => { AP.evHours[AP.groups[+inp.dataset.evh].event] = inp.value; }));
    g.querySelectorAll('[data-evh-apply]').forEach(b => b.addEventListener('click', () => {
      const grp = AP.groups[+b.dataset.evhApply]; const v = Number(AP.evHours[grp.event]);
      if (!(AP.evHours[grp.event] !== '' && isFinite(v) && v >= 0)) return;
      grp.rows.forEach(r => { r.edits.hours = v; delete r.edits.end; apTouch(r); });
      repaint();
    }));
    g.querySelectorAll('tr.ap-row').forEach(tr => {
      const r = AP.rows.get(tr.dataset.id); if (!r) return;
      tr.querySelector('[data-sel]').addEventListener('change', e => { r.sel = e.target.checked; if (r.sel) apEnsureForm(r); apRowDom(r); apCounts(); });
      const hrs = tr.querySelector('[data-hours]');
      const takeHours = () => { const n = Number(hrs.value); if (hrs.value === '') delete r.edits.hours; else if (isFinite(n)) { r.edits.hours = n; delete r.edits.end; } apTouch(r); };
      hrs.addEventListener('input', () => { takeHours(); apRowDom(r, { keepHours: true }); apCounts(); });
      hrs.addEventListener('change', () => { takeHours(); apRowDom(r); apCounts(); });
      tr.querySelector('[data-status]').addEventListener('change', e => { r.status = e.target.value; apTouch(r); apRowDom(r); apCounts(); });
      tr.querySelector('[data-times]').addEventListener('click', () => { r.timesOpen = !r.timesOpen; apEnsureForm(r); apRowDom(r); });
      const tt = g.querySelector(`tr.ap-times[data-times-for="${r.id}"]`); if (!tt) return;
      tt.querySelector('[data-start]').addEventListener('change', e => { const d = Approvals.fromLocalInput(e.target.value); if (d) r.edits.start = d; else delete r.edits.start; apTouch(r); apRowDom(r); apCounts(); });
      tt.querySelector('[data-end]').addEventListener('change', e => { const d = Approvals.fromLocalInput(e.target.value); if (d) { r.edits.end = d; delete r.edits.hours; } else delete r.edits.end; apTouch(r); apRowDom(r); apCounts(); });
    });
  }

  // --- submit → confirm → run ---
  async function apBeginConfirm() {
    const sel = apSelected(); if (!sel.length || apBusy()) return;
    AP.confirm = { loading: true, items: [] };
    await paintHours();
    await Promise.all(sel.map(apEnsureForm));
    if (!AP.confirm || !AP.confirm.loading) return;   // cancelled meanwhile
    AP.confirm = { loading: false, items: sel.map(r => {
      if (!r.form) return { r, err: 'Couldn\'t read the shift form: ' + (r.formError || 'unknown error') };
      if (r.form.status !== Approvals.STATUS.PENDING) return { r, err: `Already ${Approvals.STATUS_LABEL[r.form.status] || r.form.status} in VMS` };
      try {
        const p = Approvals.plan(r.form, { ...r.edits, status: r.status });
        const noop = p.status === r.form.status && p.hours === r2(r.form.hours) && p.start.getTime() === r.form.start.getTime() && p.end.getTime() === r.form.end.getTime();
        return { r, plan: p, noop };
      } catch (e) { return { r, err: e.message || String(e) }; }
    }) };
    await paintHours();
  }
  async function apRun() {
    if (!AP.confirm || AP.confirm.loading || AP.running) return;
    const items = AP.confirm.items.filter(i => i.plan && !i.noop);
    if (!items.length) { AP.confirm = null; paintHours(); return; }
    AP.confirm = null; AP.running = { i: 0, n: items.length };
    await paintHours();
    const res = await Approvals.run(items.map(i => ({ shiftId: i.r.id, values: i.plan, row: i.r })), {
      onProgress: (idx, result) => {
        const r = items[idx].r; r.result = result; AP.running.i = idx + 1;
        apRowDom(r);
        const n = main.querySelector('#ap-run .ap-run-n'); if (n) n.textContent = `${idx + 1} of ${items.length}`;
        const bar = main.querySelector('#ap-run .track i'); if (bar) bar.style.width = `${Math.round(100 * (idx + 1) / items.length)}%`;
      },
    });
    AP.running = null;
    AP.lastRun = { at: new Date(), done: res.done.map(d => ({ name: d.row.item.name, event: d.row.item.event, values: d.values })), failed: res.failed.map(f => ({ name: f.row.item.name, event: f.row.item.event, error: f.error })) };
    // Done ones leave the queue now; the reload below is the real check.
    for (const d of res.done) AP.rows.delete(d.shiftId);
    AP.list = AP.list.filter(it => AP.rows.has(it.shiftId));
    for (const f of res.failed) { const r = AP.rows.get(f.shiftId); if (r) { r.sel = true; r.form = null; } }   // re-read the form before any retry
    await paintHours();
    apLoad({ keepRows: true, quiet: true });
  }

  // --- the hours report (unchanged, just folded under a toggle) ---
  async function hoursReportHTML() {
    const hrs = await VMS.hours(state.hoursWin);
    const q = state.q;
    const key = state.hoursBy === 'volunteer' ? 'name' : 'event';
    const agg = new Map();
    for (const h of hrs) { const k = h[key]; const a = agg.get(k) || { label: k, completed: 0, pending: 0, count: 0, items: new Set() }; a.completed += h.completed; a.pending += h.pending; a.count++; a.items.add(h[key === 'name' ? 'event' : 'name']); agg.set(k, a); }
    const rows = sortRows([...agg.values()].map(a => ({ ...a, n: a.items.size })).filter(a => matches(q, a.label)), 'hours', 'completed', -1);
    AP.reportRows = rows;
    const totC = r2(hrs.reduce((a, h) => a + h.completed, 0)), totP = r2(hrs.reduce((a, h) => a + h.pending, 0));
    const winLabel = { '': 'Last 12 months', '90days': 'Last 90 days', '30days': 'Last 30 days' };
    return `<div class="ap-report-body">
      <div class="stats"><div class="stat"><b>${totC}</b><span>completed hours</span></div><div class="stat ${totP ? 'warn' : ''}"><b>${totP}</b><span>pending approval</span></div><div class="stat"><b>${new Set(hrs.map(h => h.name)).size}</b><span>volunteers active</span></div><div class="stat"><b>${new Set(hrs.map(h => h.event)).size}</b><span>events</span></div></div>
      <div class="bar">
        <div class="seg">${['', '90days', '30days'].map(w => `<button data-win="${w}" class="${state.hoursWin === w ? 'on' : ''}">${winLabel[w]}</button>`).join('')}</div>
        <div class="seg"><button data-by="volunteer" class="${state.hoursBy === 'volunteer' ? 'on' : ''}">By volunteer</button><button data-by="event" class="${state.hoursBy === 'event' ? 'on' : ''}">By event</button></div>
        <input type="search" placeholder="Filter…" value="${esc(q)}"><button class="btn" id="d7-csv">Download CSV</button>
      </div>
      <div class="tbl" id="ap-report-tbl"><table><thead><tr>${th(state.hoursBy === 'volunteer' ? 'Volunteer' : 'Event', 'label', 'hours', 'completed')}${th(state.hoursBy === 'volunteer' ? 'Events' : 'Volunteers', 'n', 'hours', 'completed', true)}${th('Completed hrs', 'completed', 'hours', 'completed', true)}${th('Pending hrs', 'pending', 'hours', 'completed', true)}</tr></thead><tbody>
        ${rows.map(r => `<tr><td>${esc(r.label)}</td><td class="n">${r.n}</td><td class="n"><b>${r2(r.completed)}</b></td><td class="n">${r.pending ? pill(r2(r.pending), 'amber') : '<span class="muted">0</span>'}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted" style="font-size:12px">Source: Group Lead → Reports → Volunteer Hours (approved participations, ${winLabel[state.hoursWin].toLowerCase()}).</p>
    </div>`;
  }
  function bindHoursReport() {
    const box = main.querySelector('.ap-report'); if (!box) return;
    box.querySelectorAll('[data-win]').forEach(b => b.addEventListener('click', () => { state.hoursWin = b.dataset.win; paintHours(); }));
    box.querySelectorAll('[data-by]').forEach(b => b.addEventListener('click', () => { state.hoursBy = b.dataset.by; paintHours(); }));
    // Filtering swaps just the table so the search box keeps focus.
    const inp = box.querySelector('input[type=search]');
    inp.addEventListener('input', async () => {
      state.q = inp.value;
      const tmp = document.createElement('div'); tmp.innerHTML = await hoursReportHTML();
      const cur = box.querySelector('#ap-report-tbl'); if (!cur) return;
      cur.replaceWith(tmp.querySelector('#ap-report-tbl')); bindSort(box.querySelector('#ap-report-tbl'), paintHours);
    });
    bindSort(box, paintHours);
    box.querySelector('#d7-csv').addEventListener('click', () => downloadCSV(`d0007-hours-${state.hoursBy}.csv`, [state.hoursBy === 'volunteer' ? 'Volunteer' : 'Event', 'Count', 'Completed hours', 'Pending hours'], AP.reportRows.map(r => [r.label, r.n, r2(r.completed), r2(r.pending)])));
  }

  CSS_PARTS.push(`
#d0007-root .ap-h{font-size:17px;margin:0}
#d0007-root .bar .sp{flex:1}
#d0007-root .btn.primary{background:#1f4d2b;color:#fff;border-color:#1f4d2b}
#d0007-root .btn.primary:hover{background:#2a6a3b}
#d0007-root .btn:disabled{opacity:.5;cursor:default}
#d0007-root .btn:disabled:hover{background:#fff}
#d0007-root .btn.primary:disabled:hover{background:#1f4d2b}
#d0007-root .lnk{border:0;background:none;color:#2f6b3a;cursor:pointer;font:inherit;font-size:12.5px;padding:2px 4px;text-decoration:underline;white-space:nowrap}
#d0007-root .lnk:disabled{opacity:.5;cursor:default}
#d0007-root .ap-progress{font-size:12.5px;min-height:18px;margin:-6px 0 8px}
#d0007-root .ap-group{padding:0;overflow:hidden}
#d0007-root .ap-ghead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;background:#f7f9f7;border-bottom:1px solid #dfe5e0}
#d0007-root .ap-gtitle{display:flex;flex-direction:column;min-width:0}
#d0007-root .ap-gtitle b{font-size:14.5px}
#d0007-root .ap-gtitle .muted{font-size:12px}
#d0007-root .ap-tog{border:0;background:none;font-size:14px;cursor:pointer;padding:2px 6px;color:#1f4d2b}
#d0007-root .ap-evh{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:#3a4a3d;white-space:nowrap}
#d0007-root .ap-tbl{border:0;border-radius:0;max-height:none}
#d0007-root .ap-tbl th{position:static}
#d0007-root .ap-row.sel td{background:#f2f8f3}
#d0007-root .ap-row input[type=number],#d0007-root .ap-evh input[type=number]{width:74px;border:1px solid #cfd8d0;border-radius:6px;padding:4px 6px;font:inherit;text-align:right;background:#fff}
#d0007-root .ap-row select{border:1px solid #cfd8d0;border-radius:6px;padding:4px 6px;font:inherit;background:#fff}
#d0007-root .ap-row input[type=checkbox]{width:16px;height:16px;margin:4px 0 0}
#d0007-root .ap-name{font-weight:600}
#d0007-root .ap-sub{font-size:11.5px}
#d0007-root .ap-sub:empty{display:none}
#d0007-root .ap-msg{color:#9a2b1d;font-size:12px;margin-top:2px}
#d0007-root .ap-msg:empty{display:none}
#d0007-root .ap-times td{background:#fbfcfb;font-size:12.5px;border-bottom:1px solid #e7ebe7}
#d0007-root .ap-times label{margin-right:10px;white-space:nowrap}
#d0007-root .ap-times input[type=datetime-local]{border:1px solid #cfd8d0;border-radius:6px;padding:4px 6px;font:inherit;font-size:12.5px;background:#fff}
#d0007-root .ap-spin{display:inline-block;width:12px;height:12px;border:2px solid #cfd8d0;border-top-color:#1f4d2b;border-radius:50%;animation:d7spin .8s linear infinite;vertical-align:middle;margin-left:6px}
#d0007-root .ap-ok{color:#1f5a2c;font-weight:700;margin-right:6px}
#d0007-root .ap-bad{color:#9a2b1d;font-weight:700;margin-right:6px}
#d0007-root .ap-actions{position:sticky;bottom:0;background:#fff;border:1px solid #dfe5e0;border-radius:8px;padding:10px 12px;display:flex;gap:10px;align-items:center;margin:8px 0 14px;box-shadow:0 -2px 10px rgba(0,0,0,.06)}
#d0007-root .ap-confirm{border-color:#d9b84a;background:#fffbea}
#d0007-root .ap-confirm h3{margin:0 0 8px;font-size:15px}
#d0007-root .ap-confirm ul.plain{max-height:40vh;overflow:auto;margin-bottom:8px}
#d0007-root .ap-confirm ul.plain li{display:flex;justify-content:flex-start;gap:10px}
#d0007-root .ap-confirm p{margin:8px 0 10px}
#d0007-root .ap-last ul.plain{max-height:30vh;overflow:auto}
#d0007-root .ap-last ul.plain li{justify-content:flex-start}
#d0007-root .ap-last ul.plain li .pill{margin-left:auto}
#d0007-root .ap-report{margin-top:16px}
#d0007-root .ap-report-body{margin-top:12px}
#d0007-root .ap-go{padding:2px 8px;font-size:12px;margin-left:6px}
`);
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
