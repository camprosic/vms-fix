// ==UserScript==
// @name         Cam's VMS Console
// @namespace    sja-hamilton-d0007
// @version      0.3.1
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

  // --- data layer -------------------------------------------------------
  // Plain same-origin fetch with whatever session the browser already has.
  // Read only. When national changes a page, this is the file to fix.
  //
  // The web api (/_api/) would have been the clean way to do all of this and
  // for about a week it worked. Then it got cut down to a handful of columns
  // overnight, no notice, no changelog. So instead this leans on the pages and
  // csv feeds the portals own UI runs on. Uglier, but they cant switch those
  // off without breaking their own site, which is the only kind of stability
  // I trust at this point.
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
        // Dates come back twice - Value is the ancient ASP.NET "/Date(ms)/" thing
        // and DisplayValue is ISO. Keep the ISO one.
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
    //    Heads up: get-engagements hands back the PUBLIC engagement id, not the
    //    event id every group lead page uses. Two ids for one event. The public
    //    table is still open on the web api so we translate through that.
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

    // 2. The four event lists on Group Lead > Events. Standard Power Pages
    //    subgrids, so we lift the grid config off the page and hit the subgrid
    //    endpoint directly instead of scraping the table. Theres a perfectly
    //    good JSON endpoint under every grid in the portal. A paragraph of docs
    //    about it would have saved me a weekend in DevTools.
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

    // 3. Per event: whos signed up (participations) and whos booked what
    //    (participation schedules). Both subgrids on the event-summary page. In
    //    the portal you open every event one at a time, ten rows a page, to
    //    find out whos coming. Four events on a weekend, do the math.
    const eventDetail = eventId => memo('event:' + eventId, async () => {
      const doc = await getDoc(`/en-US/group-lead/event-summary/?eventid=${encodeURIComponent(eventId)}&groupid=${GROUP_ID}`);
      const grids = gridsIn(doc);
      const pGrid = grids.find(g => /msnfp_participation_engagement/i.test(g.rel));
      const sGrid = grids.find(g => /participationschedule/i.test(g.rel));
      const [p, s] = await Promise.all([pGrid ? subgridRows(pGrid) : [], sGrid ? subgridRows(sGrid) : []]);
      const val = id => doc.getElementById(id)?.value || doc.getElementById(id)?.textContent || '';
      return {
        description: val('msnfp_shortdescription'),
        participants: p.map(r => ({ id: r.id, name: r.msnfp_contactid, contactId: r.msnfp_contactid__raw, status: r.msnfp_status, signedUp: toDate(r.createdon__raw || r.createdon), hours: num(r.msnfp_hours), pendingHours: num(r.sjavms_totalpendinghours) }))
          .sort((a, b) => norm(a.name).localeCompare(norm(b.name))),
        shifts: s.map(r => ({ id: r.id, name: r.sjavms_volunteer, contactId: r.sjavms_volunteer__raw, start: toDate(r.sjavms_start__raw || r.sjavms_start), hours: num(r.sjavms_hours), status: r.msnfp_schedulestatus }))
          .sort((a, b) => (a.start?.getTime() || 0) - (b.start?.getTime() || 0) || norm(a.name).localeCompare(norm(b.name))),
      };
    });

    // 4. Roster - the csv feed behind the Download CSV button on the Volunteers
    //    page. Honestly the most sensible thing in the whole portal.
    const roster = () => memo('roster', async () => parseCSV(await getText(`/group-lead/volunteers-by-group-csv-feed?fetchReport=&fSearch=&groupId=${GROUP_ID}`))
      .map(r => ({ name: r['Name'], email: r['Email Address'], phone: r['Phone Number'], contactId: r['Contact ID'], status: r['Status'] }))
      .sort((a, b) => norm(a.name).localeCompare(norm(b.name))));

    // 5. Hours - csv feed behind Reports > Volunteer Hours. win is '' (12 months),
    //    '90days' or '30days'. The page is ten rows at a time with no totals, so
    //    a per-person rollup means downloading the csv and doing it in Excel.
    //    Fine once a year for the awards night. Not fine every week.
    const hours = (win = '') => memo('hours:' + win, async () => parseCSV(await getText(`/group-lead/participation-reports-csv-feed?fetchReport=${encodeURIComponent(win)}&fSearch=&groupId=${GROUP_ID}`))
      .map(r => ({ name: r['Volunteer'], event: r['Volunteering Event'], completed: num(r['Total Completed Hours']), pending: num(r['Total Pending Hours']) })));

    // 6. Certifications. VMS only gives these out through the windowed reports
    //    and the report codes dont do what the menu says they do. I checked the
    //    FetchXML behind each one because the numbers made no sense:
    //      last12months -> expiry in the last 12 months
    //      next90days   -> expiry in the next 90 days
    //      nextYear     -> expiry next calendar year
    //      last90days   -> effective date THIS year (not what the label says)
    //      last30days   -> effective date LAST year (ditto)
    //    Pulling all five and de-duping is the widest view we can get. Anything
    //    gained more than two years ago that expires after next year wont show
    //    (so a 3 year MFR cert is always covered, which is the one I care about).
    //    There is no "show me everyones current certs" view anywhere in VMS.
    //    For a first response unit where a lapsed cert means you dont deploy,
    //    thats not a nice-to-have, thats the job.
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

    // 7. The few event columns the web api still lets us have: the address and
    //    the short description. Ten ids a call, cached per id. Enjoy them while
    //    they last.
    const extrasCache = new Map();
    async function eventExtras(ids) {
      const need = [...new Set(ids)].filter(id => id && !extrasCache.has(id));
      for (let i = 0; i < need.length; i += 10) {
        const chunk = need.slice(i, i + 10);
        const filter = chunk.map(id => `msnfp_engagementopportunityid eq ${id}`).join(' or ');
        try {
          const r = await fetchOk(`/_api/msnfp_engagementopportunities?$select=msnfp_engagementopportunityid,msnfp_street1,msnfp_city,msnfp_stateprovince,msnfp_zippostalcode,msnfp_shortdescription&$filter=${encodeURIComponent(filter)}`, { headers: { Accept: 'application/json' } });
          const j = await r.json();
          (j.value || []).forEach(x => extrasCache.set(x.msnfp_engagementopportunityid, { street: x.msnfp_street1 || '', city: x.msnfp_city || '', province: x.msnfp_stateprovince || '', postal: x.msnfp_zippostalcode || '', description: x.msnfp_shortdescription || '' }));
        } catch (e) { /* the web api gets narrowed without notice; the address column just goes blank */ }
        chunk.forEach(id => { if (!extrasCache.has(id)) extrasCache.set(id, null); });
      }
      return new Map(ids.map(id => [id, extrasCache.get(id) || null]));
    }

    // 8. Event id -> public engagement id (the one the public /engagement/ page
    //    wants). See 1 for why this exists at all.
    const publicIdCache = new Map();
    async function publicIdsFor(ids) {
      const need = [...new Set(ids)].filter(id => id && !publicIdCache.has(id));
      for (let i = 0; i < need.length; i += 10) {
        const chunk = need.slice(i, i + 10);
        const filter = chunk.map(id => `_msnfp_engagementopportunityid_value eq ${id}`).join(' or ');
        try {
          const r = await fetchOk(`/_api/msnfp_publicengagementopportunities?$select=msnfp_publicengagementopportunityid,_msnfp_engagementopportunityid_value&$filter=${encodeURIComponent(filter)}`, { headers: { Accept: 'application/json' } });
          const j = await r.json();
          (j.value || []).forEach(x => publicIdCache.set(x._msnfp_engagementopportunityid_value, x.msnfp_publicengagementopportunityid));
        } catch (e) { /* same story */ }
        chunk.forEach(id => { if (!publicIdCache.has(id)) publicIdCache.set(id, null); });
      }
      return new Map(ids.map(id => [id, publicIdCache.get(id) || null]));
    }

    // 9. The public event page - the one volunteers see. Every "Shift Options"
    //    row has a JSON blob on its checkbox with the shift definition: id, name
    //    (MFR / Apprentice / whatever got typed in), start, end, max and how many
    //    have booked. Also the description, qualifications and location. This
    //    is the ONLY place a group lead can see shift definitions. Not on the
    //    group lead pages. On the public one. Sure.
    const publicEvent = publicId => memo('public:' + publicId, async () => {
      const doc = await getDoc(`/engagement/?id=${encodeURIComponent(publicId)}`);
      const shifts = [...doc.querySelectorAll('input[type="checkbox"][data-value]')].map(cb => {
        let v; try { v = JSON.parse(cb.getAttribute('data-value')); } catch (e) { return null; }
        if (!v || !v.id) return null;
        const max = Number(v.maxVolunteers);
        return { id: v.id, name: decodeEntities(String(v.name || '')).trim(), start: toDate(v.startDate), end: toDate(v.endDate), max: isFinite(max) && max >= 0 ? max : null, booked: Number(v.numVolunteers) || 0, cancelled: !!v.isCancelled };
      }).filter(Boolean);
      const afterHeading = title => {
        const h = [...doc.querySelectorAll('h2')].find(n => n.textContent.trim() === title); if (!h) return [];
        const out = []; for (let n = h.nextElementSibling; n && n.tagName !== 'H2'; n = n.nextElementSibling) out.push(...(n.tagName === 'UL' || n.tagName === 'OL' ? [...n.querySelectorAll('li')] : [n]).map(x => x.textContent.replace(/\s+/g, ' ').trim()));
        return out.filter(Boolean);
      };
      const quals = afterHeading('Qualifications').filter(q => !/^none$/i.test(q));
      const m = /origEventStartDateTime\s*=\s*new Date\("([^"]+)"\)/.exec([...doc.scripts].map(x => x.textContent).join('\n'));
      return { publicId, shifts, description: (doc.querySelector('.engagementDescription')?.textContent || '').replace(/\s+/g, ' ').trim(), quals, location: afterHeading('Location').join(' '), start: m ? toDate(m[1]) : null };
    });

    // 10. Event requests still waiting on the group lead, with the organizer
    //     and on-site contact from the request form. This is the only route
    //     to those details: once a request is approved VMS stops showing it
    //     anywhere a group lead can reach. (Yes, the contact phone number
    //     disappears from view at exactly the point you start needing it.)
    const pendingRequests = () => memo('pendingRequests', async () => {
      const doc = await getDoc(`/en-US/group-lead/dashboard/?groupid=${GROUP_ID}`);
      const grid = gridsIn(doc).find(g => /eventrequest/i.test(g.rel));
      if (!grid) return [];
      const rows = await subgridRows(grid, { pageSize: 100, maxPages: 3 });
      const read = async r => {
        const id = r.sjavms_eventrequestid || r.id;
        const base = { requestId: id, name: r.sjavms_name || '', start: toDate(r.sjavms_eventstartdate__raw || r.sjavms_eventstartdate), locationName: r.sjavms_address1name || '', status: r.statuscode || '' };
        try {
          const fd = await getDoc(`/en-US/group-lead/event-general/?id=${encodeURIComponent(id)}&groupid=${GROUP_ID}`);
          const v = fid => (fd.getElementById(fid)?.value || '').trim();
          const yes = fid => !!fd.getElementById(fid + '_1')?.checked;
          const person = (f, l, e, p, org) => { const n = [v(f), v(l)].filter(Boolean).join(' '); return (n || v(e) || v(p)) ? { name: n, email: v(e), phone: v(p), organization: org ? v(org) : '' } : null; };
          return { ...base,
            end: toDate(v('sjavms_eventenddate')) || null,
            description: v('sjavms_eventdescription'),
            maxAttendees: v('sjavms_maxparticipants'),
            organizer: person('sjavms_firstname', 'sjavms_lastname', 'sjavms_email', 'sjavms_phone', 'sjavms_organization'),
            contact: person('sjavms_coordinatorfirstname', 'sjavms_coordinatorlastname', 'sjavms_coordinatoremail', 'sjavms_coordinatorphone'),
            address: { name: v('sjavms_address1name'), street: [v('sjavms_address1line1'), v('sjavms_address1line2'), v('sjavms_address1line3')].filter(Boolean).join(', '), city: v('sjavms_address1city'), province: v('sjavms_address1stateprovince'), postal: v('sjavms_address1zippostalcode') },
            onSite: { firstAidRoom: yes('sjavms_firstaidroomtent'), volunteerArea: yes('sjavms_designatedvolunteerarea'), water: yes('sjavms_cleandrinkingwater'), telephone: yes('sjavms_telephone'), cellReception: yes('sjavms_cellphonereception'), parking: yes('sjavms_parking'), bathrooms: yes('sjavms_bathrooms'), food: yes('sjavms_foodforvolunteers'), shade: yes('sjavms_shadedareaifoutside'), otherAgencies: yes('sjavms_willotherhealthcareagenciesbeonsite'), seating: yes('sjavms_tableschairsseating'), siteMap: yes('sjavms_sitemapifapplicable'), power: yes('sjavms_electricalpowersupply') },
          };
        } catch (e) { return { ...base, error: e.message || String(e) }; }
      };
      const out = [];
      for (let i = 0; i < rows.length; i += 4) out.push(...await Promise.all(rows.slice(i, i + 4).map(read)));
      return out;
    });

    return { upcomingEngagements, groupEvents, eventDetail, roster, hours, certifications, eventExtras, publicIdsFor, publicEvent, pendingRequests,
      clear: () => { cache.clear(); extrasCache.clear(); publicIdCache.clear(); token = null; } };
  })();
  D.VMS = VMS;

  // --- schedule ----------------------------------------------------------
  // The unit runs on a monthly spreadsheet. One row per event day, meet time,
  // end time, location, whos on it split into MFRs and Apprentices. Every
  // month someone sits there with VMS open in one tab and the sheet in the
  // other and copies it across by hand. This tab is the VMS side of that,
  // already in the sheets shape, so its a copy-paste and not an evening.
  //
  // Everything here comes from VMS. Nothing is typed in, nothing is stored.
  // The columns VMS has no idea about (meet at event, kit, vehicle, notes) are
  // left blank in the export for whoever keeps the sheet.
  //
  // Where it all comes from, because it is not one place:
  //  - the event list: Group Lead > Events subgrids (20-vms.js groupEvents)
  //  - shift definitions ("MFR 16:00-23:00, max 10, 3 booked"): the PUBLIC
  //    event page. Thats the only place a group lead can see them. Really.
  //  - whos booked: the event-summary page's Reported Shifts grid
  //  - which shift someone booked (so, MFR or Apprentice): only visible on the
  //    bookings approval form, one page per booking. So we read them. Certs
  //    are the first guess while thats loading.
  //  - street address: the web api, one of about ten columns it still gives us
  //  - on-site contact: the event REQUEST form. Only while the request is
  //    still pending. Approve it and VMS hides the phone number. Great.
  const Schedule = (() => {
    const COLUMNS = ['Event', 'Date', 'Meet @ St.John', 'Meet @ Event', 'Approx. End', 'Event Location', 'On-Site Coordinator', 'Event Notes', 'Medical First Responders', 'Apprentice', 'Equipment', 'Vehicle'];
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    // Unit rule VMS doesnt know about: an apprentice cant be on a shift without
    // an MFR to work under. One MFR per apprentice. Change it here if that ever
    // changes.
    const MFR_PER_APPRENTICE = 1;

    // --- dates, all in Eastern. Never use the local getters here, the browser
    //     could be anywhere and VMS stores everything in UTC.
    const F_NUM = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const F_LABEL = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
    const partsOf = (fmt, d) => { const o = {}; fmt.formatToParts(d).forEach(p => { if (p.type !== 'literal') o[p.type] = p.value; }); return o; };
    const ymd = v => { const d = toDate(v); if (!d) return ''; const p = partsOf(F_NUM, d); return `${p.year}-${p.month}-${p.day}`; };
    const hm = v => { const d = toDate(v); if (!d) return ''; const p = partsOf(F_NUM, d); return `${p.hour}:${p.minute}`; };
    const dayLabel = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); if (!m) return ''; const p = partsOf(F_LABEL, new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12))); return `${p.weekday} ${p.month} ${p.day}`; };
    const today = () => { const p = partsOf(F_NUM, new Date()); return { year: +p.year, month: +p.month }; };
    const monthLabel = (y, m) => `${MONTHS[m - 1] || ''} ${y}`;
    const minute = d => d ? Math.round(d.getTime() / 60000) : null;

    const isCancelled = s => /cancel/i.test(s || '');
    const isWaitlist = s => /wait ?list/i.test(s || '');
    const isNoShow = s => /no.?show/i.test(s || '');
    // Shift definition names are free text but every one of ours starts with
    // MFR or Apprentice ("MFR", "MFR day 3", "Apprentice - Sat").
    const kindOf = name => /^\s*mfr/i.test(name || '') ? 'MFR' : /^\s*apprentice/i.test(name || '') ? 'Apprentice' : 'Other';

    // --- roles. The thing I got wrong the first time: certs are NOT how VMS
    //     decides who is an MFR on an event, the booked shift is. Someone with
    //     a current MFR cert who booked the Apprentice shift is on the sheet as
    //     an apprentice that day. So: shift title first, certs only while the
    //     forms are loading or when a title is something unhelpful.
    const formCache = new Map();        // booking id -> { role, shiftName } for the session
    const roleByName = new Map();       // name -> last role seen on a booked shift this session (the roster uses it)
    const certRole = (name, certs) => (D.mfrCertOf ? D.mfrCertOf(name, certs) : null) ? 'MFR' : 'Apprentice';
    async function roleFromForm(bookingId) {
      if (formCache.has(bookingId)) return formCache.get(bookingId);
      let out = null;
      try {
        const f = await Approvals.loadForm(bookingId);
        // "MFR day 3 - Norfolk county fair": the shift name is the part before " - <event>"
        const shiftName = (f.scheduleName || '').replace(/\s+-\s+[^-]*$/, '').trim() || f.scheduleName || '';
        const kind = kindOf(shiftName);
        out = { role: kind === 'Other' ? null : kind, shiftName, scheduleId: norm(f.scheduleId || '') };
      } catch (e) { out = { role: null, shiftName: '', scheduleId: '', error: e.message || String(e) }; }
      formCache.set(bookingId, out);
      return out;
    }

    async function pmap(items, fn, n = 4) {
      const out = new Array(items.length); let i = 0;
      await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
      return out;
    }

    // --- one event -> its rows
    function eventRows(e, detail, pub, extra, ctx) {
      const defsAll = (pub && pub.shifts ? pub.shifts : []).filter(d => !d.cancelled && d.start).map(d => ({ ...d, kind: kindOf(d.name), day: ymd(d.start), hours: d.end ? r2((d.end - d.start) / 3600000) : null, needed: d.max === null ? null : d.max - d.booked }));
      const bookings = (detail.shifts || []).filter(s => s.start && !isCancelled(s.status)).map(s => ({ ...s, day: ymd(s.start), end: new Date(s.start.getTime() + (s.hours || 0) * 3600000) }));
      const days = [...new Set([...defsAll.map(d => d.day), ...bookings.map(b => b.day)])].filter(Boolean).sort();
      if (!days.length && e.start) days.push(ymd(e.start));
      const bookedNames = new Set(bookings.map(b => norm(b.name)));
      const noShift = (detail.participants || []).filter(p => !isCancelled(p.status) && !bookedNames.has(norm(p.name))).map(p => p.name).sort((a, b) => norm(a).localeCompare(norm(b)));
      const req = matchRequest(e, ctx.requests);
      const address = extra ? { street: extra.street, city: extra.city, province: extra.province, postal: extra.postal } : (req ? req.address : null);
      const up = ctx.staffing.get(e.id) || null;
      return days.map((day, i) => {
        const defs = defsAll.filter(d => d.day === day).sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
        const people = bookings.filter(b => b.day === day).map(b => {
          const cached = formCache.get(b.id);
          const role = cached && cached.role ? cached.role : certRole(b.name, ctx.certs);
          return { id: b.id, name: b.name, start: b.start, end: b.end, hours: b.hours, status: b.status, role, roleSource: cached && cached.role ? 'shift' : 'cert', shiftName: cached ? cached.shiftName : '', scheduleId: cached ? cached.scheduleId : '', partial: null };
        });
        const starts = defs.length ? defs.map(d => d.start) : people.map(p => p.start);
        const ends = defs.length ? defs.map(d => d.end).filter(Boolean) : people.map(p => p.end);
        const meetSJDate = starts.length ? new Date(Math.min(...starts.map(d => d.getTime()))) : null;
        const approxEndDate = ends.length ? new Date(Math.max(...ends.map(d => d.getTime()))) : null;
        const row = {
          key: `${e.id}|${day}`,
          event: { id: e.id, title: e.title, status: e.status, program: e.program, description: (extra && extra.description) || (pub && pub.description) || '', locationName: e.location || (pub && pub.location) || '', address, link: `/en-US/group-lead/event-summary/?eventid=${encodeURIComponent(e.id)}&groupid=${GROUP_ID}`, publicId: pub ? pub.publicId : null, publicLink: pub ? `/engagement/?id=${encodeURIComponent(pub.publicId)}` : null },
          date: day, dateLabel: dayLabel(day), isFirst: i === 0,
          defs, people, noShift: i === 0 ? noShift : [],
          meetSJDate, approxEndDate, meetSJ: hm(meetSJDate), approxEnd: hm(approxEndDate),
          contact: req ? req.contact : null, organizer: req ? req.organizer : null, request: req,
          quals: [...new Set([...(pub ? pub.quals : []), ...(up ? up.quals : [])])],
          vmsStaffing: up ? { signedUp: up.signedUp, minimum: up.minimum, needed: up.needed } : null,
          needsCheck: false, notes: [], staffing: null,
        };
        finalize(row);
        return row;
      });
    }

    // Match an event to a pending request by name (+/- a few characters) and a
    // start within a day. Requests dont carry the event id. Of course not.
    function matchRequest(e, requests) {
      if (!requests || !requests.length) return null;
      const n = norm(e.title), s = e.start ? e.start.getTime() : null;
      return requests.find(r => { const rn = norm(r.name); if (!rn || !(rn === n || rn.startsWith(n) || n.startsWith(rn))) return false; if (!s || !r.start) return true; return Math.abs(r.start.getTime() - s) <= 36 * 3600000; }) || null;
    }

    // Partial-shift markers, staffing and whether the role split still needs
    // checking against VMS. Re-run after roles resolve.
    function finalize(row) {
      const byKind = kind => row.defs.filter(d => d.kind === kind);
      const window = p => { const d = byKind(p.role)[0]; return d ? { start: d.start, end: d.end } : { start: row.meetSJDate, end: row.approxEndDate }; };
      const variants = [];
      row.people.forEach(p => {
        const w = window(p);
        const ds = w.start && minute(p.start) !== minute(w.start), de = w.end && minute(p.end) !== minute(w.end);
        if (!ds && !de) { p.partial = null; return; }
        const text = ds && de ? `${hm(p.start)} to ${hm(p.end)}` : ds ? `${hm(p.start)} to End` : `Start to ${hm(p.end)}`;
        let v = variants.find(x => x.text === text); if (!v) { v = { text, mark: '*'.repeat(variants.length + 2) }; variants.push(v); }
        p.partial = { text, mark: v.mark, nameMark: v.mark.slice(1) };
      });
      row.notes = variants.map(v => `${v.mark}${v.text}`);
      row.people.sort((a, b) => a.role.localeCompare(b.role) || norm(a.name).localeCompare(norm(b.name)));
      // staffing: by shift type, from VMS's own booked counts on the definitions
      // (those are exact), with our rule about apprentices on top
      const sum = (kind, f) => byKind(kind).reduce((a, d) => a + (f(d) || 0), 0);
      const hasMax = kind => byKind(kind).some(d => d.max !== null);
      const counted = kind => row.people.filter(p => p.role === kind && !isNoShow(p.status) && !isWaitlist(p.status)).length;
      const mfr = { booked: row.defs.length ? sum('MFR', d => d.booked) : counted('MFR'), max: hasMax('MFR') ? sum('MFR', d => d.max) : null };
      const app = { booked: row.defs.length ? sum('Apprentice', d => d.booked) : counted('Apprentice'), max: hasMax('Apprentice') ? sum('Apprentice', d => d.max) : null };
      mfr.needed = mfr.max === null ? 0 : Math.max(0, mfr.max - mfr.booked);
      app.over = app.max === null ? 0 : Math.max(0, app.booked - app.max);
      const uncovered = Math.max(0, app.booked - mfr.booked * MFR_PER_APPRENTICE);   // apprentices with no MFR to work under
      const problems = [];
      if (mfr.needed) problems.push(`${mfr.needed} MFR${mfr.needed === 1 ? '' : 's'} short of the ${mfr.max} VMS asks for`);
      if (uncovered) problems.push(`${uncovered} apprentice${uncovered === 1 ? '' : 's'} with no MFR to work under (${app.booked} apprentice${app.booked === 1 ? '' : 's'}, ${mfr.booked} MFR${mfr.booked === 1 ? '' : 's'})`);
      if (app.over) problems.push(`${app.over} more apprentice${app.over === 1 ? '' : 's'} than the shift allows`);
      row.staffing = { mfr, app, uncovered, problems, ok: !mfr.needed && !uncovered, level: mfr.needed || uncovered ? 'short' : app.over ? 'warn' : 'ok', known: row.defs.length > 0 };
      row.groups = groupsFor(row);
      // does the name split agree with VMS's counts? if not the forms get read
      row.needsCheck = row.defs.length > 0 && row.people.some(p => p.roleSource !== 'shift') && (counted('MFR') !== mfr.booked || counted('Apprentice') !== app.booked);
      return row;
    }

    // Names under the shift they actually booked - "MFR day 3", "Apprentice" -
    // matched on the shift definition id the approval form gives us, so its
    // exact. Until that form is in, a booking sits under the first definition
    // of its guessed kind. If a booking points at a shift the public page
    // doesnt list (cancelled, or a definition we cant see) it gets its own
    // group with whatever name the form had.
    function groupsFor(row) {
      const groups = row.defs.map(d => ({ def: d, name: d.name, kind: d.kind, people: [] }));
      const extra = new Map();
      row.people.forEach(p => {
        let g = p.scheduleId ? groups.find(x => norm(x.def.id) === p.scheduleId) : null;
        if (!g && p.scheduleId && p.shiftName) { if (!extra.has(p.scheduleId)) extra.set(p.scheduleId, { def: null, name: p.shiftName, kind: p.role, people: [] }); g = extra.get(p.scheduleId); }
        if (!g) g = groups.find(x => x.kind === p.role) || null;
        if (!g) { const k = 'kind:' + p.role; if (!extra.has(k)) extra.set(k, { def: null, name: p.role, kind: p.role, people: [] }); g = extra.get(k); }
        g.people.push(p);
      });
      return [...groups, ...extra.values()];
    }

    // --- the month
    async function monthRows(year, month, { onProgress } = {}) {
      const prefix = `${year}-${String(month).padStart(2, '0')}`;
      const say = (phase, done, total) => { if (onProgress) onProgress({ phase, done, total }); };
      say('events', 0, 0);
      const [ev, certs, up, requests] = await Promise.all([VMS.groupEvents(), VMS.certifications().catch(() => []), VMS.upcomingEngagements().catch(() => []), VMS.pendingRequests().catch(() => [])]);
      const seen = new Set(), events = [];
      ['current', 'upcoming', 'past'].forEach(k => (ev[k] || []).forEach(e => { if (e.id && !seen.has(e.id)) { seen.add(e.id); events.push(e); } }));
      // Only open events that could have a day in this month: anything starting
      // in the six weeks before it (a fair that straddles the month end) up to
      // the end of it. Past events go back years and every one is three fetches.
      const lo = ymd(new Date(Date.UTC(year, month - 1, 1) - 45 * 86400000)), hi = `${prefix}-31`;
      const cand = events.filter(e => { const s = ymd(e.start); return s && s >= lo && s <= hi; });
      const ids = cand.map(e => e.id);
      const [extras, pubIds] = await Promise.all([VMS.eventExtras(ids).catch(() => new Map()), VMS.publicIdsFor(ids).catch(() => new Map())]);
      let done = 0;
      const got = await pmap(cand, async e => {
        const [detail, pub] = await Promise.all([
          VMS.eventDetail(e.id).catch(err => ({ error: err.message || String(err), participants: [], shifts: [] })),
          pubIds.get(e.id) ? VMS.publicEvent(pubIds.get(e.id)).catch(() => null) : Promise.resolve(null),
        ]);
        say('events', ++done, cand.length);
        return { detail, pub };
      }, 4);
      const ctx = { certs, requests, staffing: new Map(up.map(u => [u.id, u])) };
      const rows = [];
      cand.forEach((e, i) => eventRows(e, got[i].detail, got[i].pub, extras.get(e.id), ctx).forEach(r => { if (r.date.startsWith(prefix)) rows.push(r); }));
      rows.sort((a, b) => a.date.localeCompare(b.date) || (minute(a.meetSJDate) || 0) - (minute(b.meetSJDate) || 0) || norm(a.event.title).localeCompare(norm(b.event.title)));
      return rows;
    }

    // Read the approval form for every booking we havent seen this session and
    // put people in the column VMS actually has them in. One page per booking,
    // three at a time. onEach fires per row as it settles so the screen can
    // repaint rows instead of waiting for the whole month.
    async function resolveRoles(rows, { onProgress, onRow, all = true } = {}) {
      const todo = rows.filter(r => all ? r.people.some(p => p.roleSource !== 'shift') : r.needsCheck);
      const ids = [...new Set(todo.flatMap(r => r.people.filter(p => p.roleSource !== 'shift').map(p => p.id)))];
      let done = 0;
      if (onProgress) onProgress({ phase: 'roles', done, total: ids.length });
      const settled = new Set();
      await pmap(ids, async id => {
        await roleFromForm(id);
        done++; if (onProgress) onProgress({ phase: 'roles', done, total: ids.length });
        // repaint any row whose people are all accounted for now
        settled.add(id);
        for (const r of todo) if (!r._done && r.people.every(p => p.roleSource === 'shift' || settled.has(p.id))) { r._done = true; applyRoles(r); if (onRow) onRow(r); }
      }, 3);
      todo.forEach(r => { if (!r._done) { r._done = true; applyRoles(r); if (onRow) onRow(r); } });
      return rows;
    }
    function applyRoles(row) {
      row.people.forEach(p => { const c = formCache.get(p.id); if (!c) return; p.shiftName = c.shiftName; p.scheduleId = c.scheduleId; if (c.role) { p.role = c.role; p.roleSource = 'shift'; roleByName.set(norm(p.name), c.role); } });
      finalize(row);
      row.needsCheck = false;
    }

    // --- the sheets cells
    const nameOf = p => `${p.name}${p.partial ? p.partial.nameMark : ''}`;
    const addrLines = r => { const a = r.event.address; return [r.event.locationName, a && a.street, a && [a.city, a.province].filter(Boolean).join(', ') + (a.postal ? `  ${a.postal}` : '')].map(x => (x || '').trim()).filter(Boolean); };
    const contactLines = r => r.contact ? [r.contact.name, r.contact.phone, r.contact.email].filter(Boolean) : [];
    const onSheet = p => !isNoShow(p.status) && !isWaitlist(p.status);
    function rowCells(r) {
      const names = role => r.people.filter(p => p.role === role && onSheet(p)).map(nameOf).join('\n');
      return [r.event.title, r.dateLabel, r.meetSJ, '', r.approxEnd, addrLines(r).join('\n'), contactLines(r).join('\n'), r.notes.join('\n'), names('MFR'), names('Apprentice'), '', ''].map(v => String(v ?? ''));
    }
    // Header first, a blank spacer between dates like the sheet does.
    function toWorkbookRows(rows, { spacers = true } = {}) {
      const out = [COLUMNS.slice()]; let prev = null;
      (rows || []).forEach(r => { if (spacers && prev && prev !== r.date) out.push(COLUMNS.map(() => '')); out.push(rowCells(r)); prev = r.date; });
      return out;
    }
    const tsvCell = v => /[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const toTSV = (rows, opts) => toWorkbookRows(rows, opts).map(r => r.map(tsvCell).join('\t')).join('\n');

    // --- .xlsx, written by hand. An xlsx is a zip of a few XML files and the
    //     month is a few KB, so: stored zip, no library, no CDN.
    const WIDTHS = [28, 11, 9, 9, 9, 28, 22, 20, 26, 22, 12, 12];
    const lines = s => String(s || '').split(/\r?\n/).filter(Boolean);
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
      const aoa = toWorkbookRows(rows);
      const name = String(sheetName).replace(/[\[\]:*?\/\\]/g, '').slice(0, 31) || 'Schedule';
      const sheetRows = aoa.map((cells, ri) => {
        const s = ri === 0 ? 1 : 0;
        const nLines = Math.max(1, ...cells.map((v, ci) => lines(v).reduce((a, l) => a + Math.max(1, Math.ceil(l.length / WIDTHS[ci])), 0)));
        const cs = cells.map((v, ci) => v === '' ? (s ? `<c r="${colRef(ci)}${ri + 1}" s="${s}"/>` : '') : `<c r="${colRef(ci)}${ri + 1}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`).join('');
        return `<row r="${ri + 1}" ht="${15 * nLines + 3}" customHeight="1">${cs}</row>`;
      }).join('');
      const xml = body => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
      const align = '<alignment vertical="top" wrapText="1"/>';
      const sheet = xml(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${colRef(COLUMNS.length - 1)}${aoa.length}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${WIDTHS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${sheetRows}</sheetData><pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`);
      const styles = xml(`<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1">${align}</xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">${align}</xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
      return zipStored([
        { name: '[Content_Types].xml', text: xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>') },
        { name: '_rels/.rels', text: xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
        { name: 'xl/workbook.xml', text: xml(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
        { name: 'xl/_rels/workbook.xml.rels', text: xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') },
        { name: 'xl/styles.xml', text: styles },
        { name: 'xl/worksheets/sheet1.xml', text: sheet },
      ]);
    }

    return { COLUMNS, MFR_PER_APPRENTICE, monthRows, resolveRoles, eventRows, finalize, groupsFor, kindOf, roleFromForm, roleByName, formCache, rowCells, toTSV, toWorkbookRows, toXLSX, ymd, hm, dayLabel, today, monthLabel };
  })();
  D.Schedule = Schedule;

  // --- approvals ---------------------------------------------------------
  // The one place this writes to VMS: approving (or no-showing / cancelling /
  // fixing) the shifts people reported. In the portal thats Group Lead > Hours,
  // ten rows a page, one modal per shift, 3-4 clicks each. After a Ti-Cats
  // weekend with 40 shifts thats my whole evening gone, and 95% of it is
  // clicking Submit on a number I already checked against the event form.
  // 143 pending when I started writing this. One hundred and forty three.
  //
  // What the portal does and what this copies, exactly:
  //  - the Hours page renders the pending list as inline JS - one block of
  //    variable assignments per shift and then a jQuery append into the table.
  //    So we read the assignments with a regex. no eval, dont worry.
  //  - each shifts Approve link opens an entity form (modal-form-template-path)
  //    over msnfp_participationschedule with start, end, hours and status.
  //    Submit is a plain WebForms postback. We fill the same four fields on the
  //    same form, submit it the same way, and look for the same "Submission
  //    completed successfully." that the portals own modal looks for before it
  //    closes itself.
  // Nothing goes near the web api (see 20-vms.js for why) and nothing about
  // field names is guessed. If the form that comes back doesnt have the inputs
  // we expect, or is for a different record than we asked for, it stops cold
  // before posting anything. I'd rather it fail loudly than approve the wrong
  // persons hours.
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

    // Same-origin fetch with the same expired-session check the VMS module
    // has. That module keeps its helpers to itself and this one needs to POST,
    // so it gets its own copy. Not thrilled about the duplication either.
    async function fetchOk(url, { timeout = 30000, ...opts } = {}) {
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ac && setTimeout(() => ac.abort(), timeout);
      let r;
      try { r = await fetch(url, { credentials: 'same-origin', signal: ac ? ac.signal : undefined, ...opts }); }
      catch (e) { throw new Error(ac && ac.signal.aborted ? `VMS didn't answer within ${Math.round(timeout / 1000)} s.` : (e.message || String(e))); }
      finally { if (timer) clearTimeout(timer); }
      if (r.redirected && /signin|b2clogin|login/i.test(r.url)) throw new Error('Your VMS session has expired. Sign in to the portal, then press Refresh.');
      if (!r.ok) throw new Error(`${String(url).split('?')[0]} → HTTP ${r.status}`);
      return r;
    }
    const getText = url => fetchOk(url).then(r => r.text());
    const getDoc = url => getText(url).then(t => new DOMParser().parseFromString(t, 'text/html'));

    // --- dates ---
    const pad = n => String(n).padStart(2, '0');
    // CRM wants 2026-07-26T16:00:00.0000000Z - seven fraction digits, UTC.
    // Seven. Not six, not three. Seven.
    function toCrmIso(v) {
      const d = toDate(v); if (!d) throw new Error('Not a date: ' + v);
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.0000000Z`;
    }
    // Safari's Date.parse chokes on those seven digits so this parses by hand.
    function fromCrmIso(s) {
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(String(s ?? '').trim());
      if (!m) return toDate(s);
      let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? Math.round(+('0.' + m[7]) * 1000) : 0);
      if (m[8] && m[8] !== 'Z') { const o = /([+-])(\d{2}):?(\d{2})/.exec(m[8]); ms -= (o[1] === '-' ? -1 : 1) * ((+o[2]) * 60 + (+o[3])) * 60000; }
      return new Date(ms);
    }
    // Eastern wall clock <-> Date for the datetime-local inputs. The form wants
    // UTC, people want Eastern. These two exist so nobody has to do that math
    // at 11pm.
    const partsIn = d => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d).filter(p => p.type !== 'literal').map(p => [p.type, +p.value]));
    function toLocalInput(v) { const d = toDate(v); if (!d) return ''; const p = partsIn(d); return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`; }
    function fromLocalInput(s) {
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s ?? '').trim()); if (!m) return null;
      const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
      const off = d => { const p = partsIn(d); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(d.getTime() / 1000) * 1000; };
      // two passes so the DST changeover days come out right
      let d = new Date(wall - off(new Date(wall)));
      d = new Date(wall - off(d));
      // 02:30 on spring-forward day doesn't exist; land on 03:30 like a clock would
      if (toLocalInput(d) !== `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`) d = new Date(d.getTime() + 3600000);
      return d;
    }

    // --- the pending list ---
    // There is no feed for this. The page builds the table from inline JS,
    // one block per shift, like:
    //   shiftId = "guid"; origStartDate = "Sun, 26 Jul 2026 16:00:00 GMT";
    //   volunteerName = "..."; eventName = "..."; actionButton = ...;
    //   $("#pendingShiftsTable").append("<tr><td>" + volunteerName + ... + startDateInEST + "</td><td>5</td> ...
    // The reported hours only exist as that literal <td> in the append string.
    // Not as a variable. Just sitting in the HTML. So we read it from there.
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

    // Walks the Hours pages. Page 1 tells us how many records there are, the
    // rest get fetched four at a time. onPage gets { loaded, total, pages,
    // truncated } as they land so the screen can show a progress line instead
    // of just sitting there.
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
    // Refuses to go any further unless the page is the form we expect, for the
    // record we asked for. Cheap insurance against national changing the form
    // under us (they will, eventually, without telling anyone) and this thing
    // posting into the wrong place.
    function checkForm(doc, shiftId) {
      const idInput = doc.getElementById('EntityFormControl_EntityFormView_EntityID');
      if (!idInput) throw new Error('The approval form has no record id field. VMS may have changed the form; not posting.');
      if (norm(idInput.value) !== norm(shiftId)) throw new Error(`The form that loaded is for a different record (${idInput.value}), not ${shiftId}. Not posting.`);
      const ent = doc.getElementById('EntityFormControl_EntityFormView_EntityName');
      if (!ent) throw new Error('The approval form has no entity name field. VMS may have changed the form; not posting.');
      if (ent.value !== 'msnfp_participationschedule') throw new Error(`Expected a participation-schedule form, got "${ent.value}". Not posting.`);
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
      const hraw = v('sjavms_hours').trim();
      if (hraw && !/^\d+(\.\d+)?$/.test(hraw)) throw new Error(`The form's hours value "${hraw}" isn't a plain number; not touching this shift.`);
      return { shiftId, participation: v('msnfp_participationid_name'), scheduleName: v('msnfp_engagementopportunityscheduleid_name'), scheduleId: v('msnfp_engagementopportunityscheduleid'), participationId: v('msnfp_participationid'), start: fromCrmIso(v('sjavms_start')), end: fromCrmIso(v('sjavms_end')), hours: hraw ? Number(hraw) : 0, status, statusOptions };
    }
    // Belt and suspenders at post time: the form we're about to submit has to
    // still be Pending, for the volunteer we think it is, and (if the caller
    // tells us what it read earlier) unchanged since then. Another lead can
    // approve the same shift while you're looking at it - we dont paint over
    // that, we bail and tell you.
    function verifyLive(doc, shiftId, expect) {
      if (!expect) return;
      const live = readForm(doc, shiftId);
      const want = expect.status || STATUS.PENDING;
      if (live.status !== want) throw new Error(`This shift is now "${STATUS_LABEL[live.status] || live.status}" in VMS, not ${STATUS_LABEL[want]}. Someone else got to it; reload the list.`);
      if (expect.name && live.participation && !norm(live.participation).startsWith(norm(expect.name))) throw new Error(`The form is for "${live.participation}", not ${expect.name}. Not posting.`);
      const near = (a, b) => (!a && !b) || (a && b && Math.abs(toDate(a).getTime() - toDate(b).getTime()) < 60000);
      if ((expect.start && !near(live.start, expect.start)) || (expect.end && !near(live.end, expect.end)) || (expect.hours !== undefined && expect.hours !== null && Math.abs(live.hours - expect.hours) > 0.005)) {
        throw new Error('This shift changed in VMS since it was read (times or hours differ). Reload the list and check it again.');
      }
    }
    const loadForm = async shiftId => readForm(await getDoc(formUrl(shiftId)), shiftId);

    // Pure function. Works out what the four fields should be from the loaded
    // form plus whatever you changed, and refuses the combos VMS would reject or
    // that are obviously wrong (negative hours, end before start, a 30 hour
    // shift...). The screen runs this on every keystroke so what you see in
    // the row is exactly what gets sent.
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
        // Nothing about the length changed - keep the forms hours, and its end
        // too unless the start moved (then the whole shift slides).
        hours = Number(form.hours) || 0;
        const fs = toDate(form.start);
        if (fs && fs.getTime() === start.getTime()) end = toDate(form.end);
      }
      if (end === null) { hours = r2(hours); end = new Date(Math.round((start.getTime() + hours * 3600000) / 60000) * 60000); }
      else if (hours === null) hours = r2((end.getTime() - start.getTime()) / 3600000);
      else hours = r2(hours);
      if (end.getTime() < start.getTime()) throw new Error('Shift end is before its start');
      if (hours > 24) throw new Error(`${hours} hours is more than a day; check the times or split the shift`);
      if (status === STATUS.APPROVED && !(hours > 0)) throw new Error('Approving a shift needs more than zero hours');
      return { start, end, hours, status };
    }

    // --- submitting ---
    // Sets the four inputs on a (parsed or live) form document and fires change
    // on each one, same as if someone typed it. Throws if the status isnt one
    // of the forms options.
    function fillForm(doc, fields) {
      for (const [id, val] of Object.entries(fields)) {
        const n = doc.getElementById(id);
        n.value = val;
        if (n.tagName === 'SELECT' && n.value !== val) throw new Error(`Status ${val} is not an option on this form`);
        const ev = doc.createEvent('Event'); ev.initEvent('change', true, true); n.dispatchEvent(ev);
      }
    }
    // What the portals own modal checks for after the postback. So its what we
    // check for too - no guessing.
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

    // The real driver. A hidden same-origin iframe loads the actual form, so the
    // portals own scripts (date pickers, client validators, the WebForms
    // postback) all run exactly like they do in the modal. Sequence:
    //   1. iframe <- GET modal form
    //   2. on load: sanity-check the form, set the four fields, fire change
    //   3. click #UpdateButton (its onclick validates then posts back);
    //      if the postback script isn't there, set __EVENTTARGET and form.submit()
    //   4. shortly after: if the page's validators said no, bail with their text
    //   5. on the next load: #MessageLabel == success, else collect the errors
    //   6. always remove the iframe; 45 s without an answer is a failure
    function iframeDriver(shiftId, fields, { timeout = 45000, expect } = {}) {
      return new Promise((resolve, reject) => {
        const f = document.createElement('iframe');
        f.style.display = 'none'; f.setAttribute('aria-hidden', 'true'); f.setAttribute('title', 'VMS approval form');
        let phase = 'form', settled = false;
        const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); try { f.remove(); } catch (e) { /* already gone */ } fn(v); };
        const timer = setTimeout(() => finish(reject, new Error(`VMS took more than ${Math.round(timeout / 1000)} s to answer. The shift may or may not have been updated; reload the list before trying again.`)), timeout);
        f.addEventListener('load', () => {
          try {
            // If you're reading this you're either debugging a failed approval or
            // you're from national wondering how a group lead is posting to your
            // form without the modal. Built out of spite, mostly. Cam Prosic,
            // Deputy Chief Ops, SJA Hamilton D0007. Happy to walk you through it.
            let doc = null, href = '';
            try { doc = f.contentDocument; href = f.contentWindow && f.contentWindow.location.href; } catch (e) { doc = null; }
            if (href === 'about:blank') return;   // some browsers fire a load for the empty frame first
            if (!doc) throw new Error('Could not read the approval form (the frame landed somewhere this script can\'t see, probably the sign-in page). Sign in to the portal, then press Refresh.');
            const w = f.contentWindow;
            if (/signin|b2clogin|login/i.test(href)) throw new Error('Your VMS session has expired. Sign in to the portal, then press Refresh.');
            if (phase === 'result') { finish(resolve, readResult(doc)); return; }
            phase = 'result';
            const { form, btn } = checkForm(doc, shiftId);
            verifyLive(doc, shiftId, expect);
            fillForm(doc, fields);
            const viaClick = typeof w.WebForm_DoPostBackWithOptions === 'function' && btn.getAttribute('onclick');
            try { console.info('[VMS console] posting approval for', shiftId, viaClick ? 'via the form\'s Submit button' : 'via form.submit() fallback'); } catch (e) { /* no console */ }
            if (viaClick) btn.click();
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
    async function fetchDriver(shiftId, fields, { expect } = {}) {
      const url = formUrl(shiftId);
      const doc = await getDoc(url);
      const { form, btn } = checkForm(doc, shiftId);
      verifyLive(doc, shiftId, expect);
      fillForm(doc, fields);
      const body = new URLSearchParams();
      for (const n of form.querySelectorAll('input, select, textarea')) {
        if (!n.name || n.disabled) continue;
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
    // expect (optional): { status, start, end, hours, name } as read earlier;
    // the driver refuses to post if the live form no longer matches.
    async function submit(shiftId, values, { driver, timeout, expect } = {}) {
      if (!shiftId) throw new Error('No shift id');
      const fields = fieldsFor(values);
      const drv = typeof driver === 'function' ? driver : drivers[driver || api.defaultDriver] || drivers.iframe;
      return drv(shiftId, fields, { timeout, expect });
    }

    // Sequential on purpose: one shift at a time, the way a person does it,
    // and so a failure is attributable. items: [{ shiftId, values, ...rest }].
    async function run(items, { driver, onProgress, stopOnError = false } = {}) {
      const done = [], failed = [];
      try {
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          let result;
          try { result = await submit(it.shiftId, it.values, { driver, expect: it.expect }); done.push({ ...it, result }); }
          catch (e) { result = { ok: false, error: e.message || String(e) }; failed.push({ ...it, error: result.error }); }
          // The screen's progress hook must never be able to stop the loop.
          if (onProgress) { try { onProgress(i, result, it); } catch (e) { try { console.warn('[VMS console] progress hook failed', e); } catch (_) { /* no console */ } } }
          if (!result.ok && stopOnError) break;
        }
      } finally {
        // Hours and event detail are now stale whatever happened.
        VMS.clear();
      }
      return { done, failed };
    }

    const api = { STATUS, STATUS_LABEL, FORM_ID, SUCCESS, formUrl, hoursUrl, parseHoursPage, pending, loadForm, plan, submit, run, verifyLive, toCrmIso, fromCrmIso, toLocalInput, fromLocalInput, readResult, drivers, defaultDriver: 'iframe' };
    return api;
  })();
  D.Approvals = Approvals;

  // --- styles -----------------------------------------------------------
  // All scoped under #d0007-root so we dont fight the portals bootstrap. The
  // green is close to the SJA green, the rest is whatever didnt look terrible.
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
#d0007-root .track i.amber{background:#d9a441}
#d0007-root .staff-l{min-width:130px}
#d0007-root .staff-pills{margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;align-items:center}
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
  // Screens push their own css onto this so they dont have to edit this file.
  const CSS_PARTS = [CSS];

  // --- ui -------------------------------------------------------------
  // No framework. innerHTML + template strings + esc() on anything that came
  // from VMS, then bind events after. Its a userscript, not a startup.
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

  // Each render gets a ticket. A slow tab that finishes loading after you've
  // already clicked somewhere else must not paint over the new one (it did,
  // once, and it was confusing as hell).
  let renderTicket = 0;
  function render() {
    const ticket = ++renderTicket;
    root.querySelector('nav').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
    main.innerHTML = '<div class="load">Loading…</div>';
    const tab = TABS.find(t => t.id === state.tab) || TABS[0];
    Promise.resolve().then(() => tab.render()).catch(e => { if (ticket === renderTicket) main.innerHTML = `<div class="wrap"><div class="err"><b>Couldn't load data.</b> ${esc(e.message || e)}</div></div>`; });
  }
  // Screens call this before touching main after an await - if it comes back
  // false the person has moved on and the screen should just stop.
  const stillCurrent = tabId => state.tab === tabId;

  // ---- Events ----
  // The home page works out "N volunteers still needed" per event card, as one
  // number. One number is useless to us: 7 bodies on a Ti-Cats game where 6 are
  // apprentices isnt covered, its a problem. So this counts MFRs and
  // apprentices seperately, off the shift definitions on the public event page
  // (the only place VMS shows them), and applies the rule VMS doesnt have: an
  // apprentice needs an MFR to work under (Schedule.MFR_PER_APPRENTICE).
  //
  // Staffing per event, both shift types, across every day of the event.
  function eventStaffing(pub) {
    if (!pub || !pub.shifts || !pub.shifts.length) return null;
    const live = pub.shifts.filter(d => !d.cancelled);
    const sum = (kind, f) => live.filter(d => Schedule.kindOf(d.name) === kind).reduce((a, d) => a + (f(d) || 0), 0);
    const hasMax = kind => live.some(d => Schedule.kindOf(d.name) === kind && d.max !== null);
    const mfr = { booked: sum('MFR', d => d.booked), max: hasMax('MFR') ? sum('MFR', d => d.max) : null };
    const app = { booked: sum('Apprentice', d => d.booked), max: hasMax('Apprentice') ? sum('Apprentice', d => d.max) : null };
    mfr.needed = mfr.max === null ? 0 : Math.max(0, mfr.max - mfr.booked);
    app.over = app.max === null ? 0 : Math.max(0, app.booked - app.max);
    const uncovered = Math.max(0, app.booked - mfr.booked * Schedule.MFR_PER_APPRENTICE);
    const problems = [];
    if (mfr.needed) problems.push(`${mfr.needed} MFR${mfr.needed === 1 ? '' : 's'} needed`);
    if (uncovered) problems.push(`${uncovered} apprentice${uncovered === 1 ? '' : 's'} with no MFR`);
    if (app.over) problems.push(`${app.over} apprentice${app.over === 1 ? '' : 's'} over the limit`);
    return { mfr, app, uncovered, problems, level: mfr.needed || uncovered ? 'short' : app.over ? 'warn' : 'ok', days: new Set(live.map(d => Schedule.ymd(d.start))).size };
  }
  const pubCache = new Map();   // event id -> public page, for the session
  async function staffingFor(events) {
    const ids = events.map(e => e.id).filter(id => !pubCache.has(id));
    const pubIds = ids.length ? await VMS.publicIdsFor(ids).catch(() => new Map()) : new Map();
    let i = 0;
    await Promise.all(Array.from({ length: 4 }, async () => { while (i < ids.length) { const id = ids[i++]; const pid = pubIds.get(id); pubCache.set(id, pid ? await VMS.publicEvent(pid).catch(() => null) : null); } }));
    return new Map(events.map(e => [e.id, eventStaffing(pubCache.get(e.id))]));
  }
  async function renderEvents() {
    const [ev, up] = await Promise.all([VMS.groupEvents(), VMS.upcomingEngagements().catch(() => [])]);
    if (!stillCurrent('events')) return;
    const vms = new Map(up.map(e => [e.id, e]));
    const list = ev[state.evSet] || [];
    const q = state.q;
    const rows = list.filter(e => matches(q, e.title, e.location, e.program, e.status));
    const upcomingAll = [...(ev.current || []), ...(ev.upcoming || [])];
    const staffing = await staffingFor(state.evSet === 'past' || state.evSet === 'adhoc' ? rows : upcomingAll);
    if (!stillCurrent('events')) return;
    const st = upcomingAll.map(e => staffing.get(e.id)).filter(Boolean);
    const shortMfr = st.filter(s => s.mfr.needed > 0), uncovered = st.filter(s => s.uncovered > 0);
    const html = `<div class="wrap">
      <div class="stats">
        <div class="stat"><b>${upcomingAll.length}</b><span>upcoming + in progress</span></div>
        <div class="stat ${shortMfr.length ? 'warn' : ''}"><b>${shortMfr.reduce((a, s) => a + s.mfr.needed, 0)}</b><span>MFRs needed across ${shortMfr.length} event${shortMfr.length === 1 ? '' : 's'}</span></div>
        <div class="stat ${uncovered.length ? 'warn' : ''}"><b>${uncovered.reduce((a, s) => a + s.uncovered, 0)}</b><span>apprentices with no MFR (${uncovered.length} event${uncovered.length === 1 ? '' : 's'})</span></div>
        <div class="stat"><b>${st.filter(s => s.level === 'ok').length}</b><span>covered</span></div>
      </div>
      <div class="bar">
        <div class="seg">${['upcoming', 'current', 'past', 'adhoc'].map(k => `<button data-set="${k}" class="${state.evSet === k ? 'on' : ''}">${{ upcoming: 'Upcoming', current: 'Current', past: 'Past', adhoc: 'Ad hoc' }[k]} (${(ev[k] || []).length})</button>`).join('')}</div>
        <input type="search" placeholder="Filter events…" value="${esc(q)}">
      </div>
      ${rows.length ? '' : '<div class="card muted">No events in this list.</div>'}
      ${rows.map(e => eventCard(e, staffing.get(e.id), vms.get(e.id))).join('')}
    </div>`;
    main.innerHTML = html;
    main.querySelectorAll('[data-set]').forEach(b => b.addEventListener('click', () => { state.evSet = b.dataset.set; state.openEvent = null; render(); }));
    const inp = main.querySelector('input[type=search]'); inp.addEventListener('input', () => { state.q = inp.value; renderEvents(); });
    main.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => { state.openEvent = state.openEvent === b.dataset.open ? null : b.dataset.open; renderEvents(); }));
    if (state.openEvent) loadDetail(state.openEvent);
  }
  function eventCard(e, st, s) {
    const open = state.openEvent === e.id;
    let staff = '';
    if (st) {
      const bar = (label, x) => { const pct = x.max ? Math.min(100, Math.round(100 * x.booked / x.max)) : 100; return `<div class="staff"><span class="staff-l"><b>${esc(label)}</b> ${x.booked}${x.max !== null ? ` of ${x.max}` : ' booked'}</span><div class="track"><i class="${x.needed ? 'red' : x.over ? 'amber' : ''}" style="width:${pct}%"></i></div></div>`; };
      staff = `${bar('MFR', st.mfr)}${bar('Apprentice', st.app)}<div class="staff-pills">${st.level === 'ok' ? pill('Covered', 'green') : ''}${st.problems.map(p => pill(p, st.level === 'short' ? 'red' : 'amber')).join(' ')}${st.days > 1 ? `<span class="muted"> · ${st.days} days</span>` : ''}</div>`;
    } else if (s) {
      // no shift definitions to go on (no public page) - fall back to the one number VMS gives
      staff = `<div class="staff"><span><b>${s.signedUp}</b> signed up${s.minimum ? ` · min <b>${s.minimum}</b>` : ''}</span>${s.needed ? pill(`${s.needed} still needed`, 'red') : ''}<span class="muted">no shift breakdown in VMS for this one</span></div>`;
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
      // which shift each person booked: name on the public page's definitions,
      // matched by id off the booking's approval form (one read per booking,
      // cached for the session - same cache the Schedule tab uses)
      const pub = pubCache.get(id) || null;
      const defById = new Map((pub && pub.shifts ? pub.shifts : []).map(x => [norm(x.id), x]));
      const shiftOf = s => { const c = Schedule.formCache.get(s.id); if (!c) return null; const def = defById.get(c.scheduleId); return def ? def.name : (c.shiftName || null); };
      const bookedBy = new Map(); d.shifts.forEach(s => { if (!isCancelledStatus(s.status)) bookedBy.set(norm(s.name), s); });
      const paint = () => {
        const groups = new Map();
        d.shifts.forEach(s => { const k = shiftOf(s) || (Schedule.formCache.has(s.id) ? 'Shift not on the public page' : '…'); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); });
        const order = [...groups.keys()].sort((a, b) => (a === '…') - (b === '…') || a.localeCompare(b));
        box.innerHTML = `
        ${d.description ? `<p class="muted" style="margin:0 0 8px">${esc(d.description)}</p>` : ''}
        <div class="bar"><b>Sign-ups (${d.participants.length})</b> ${Object.entries(byStatus).map(([k, v]) => statusPill(`${k}: ${v}`)).join(' ')}</div>
        ${d.participants.length ? `<div class="tbl"><table><thead><tr><th>Volunteer</th><th>Status</th><th>Booked shift</th><th>Signed up</th><th class="n">Hours</th><th class="n">Pending</th></tr></thead><tbody>
          ${d.participants.map(p => { const b = bookedBy.get(norm(p.name)); const sh = b ? shiftOf(b) : null; return `<tr><td>${esc(p.name)}</td><td>${statusPill(p.status)}</td><td>${b ? (sh ? esc(sh) : '<span class="muted">…</span>') : '<span class="muted">no shift booked</span>'}</td><td>${esc(fmtD(p.signedUp))}</td><td class="n">${p.hours || ''}</td><td class="n">${p.pendingHours || ''}</td></tr>`; }).join('')}
        </tbody></table></div>` : '<div class="muted">Nobody has signed up yet.</div>'}
        ${d.shifts.length ? `<div class="bar" style="margin-top:12px"><b>Booked shifts (${d.shifts.length})</b>${d.shifts.some(x => !Schedule.formCache.has(x.id)) ? '<span class="muted" id="d7-shiftprog"></span>' : ''}</div><div class="tbl"><table><thead><tr><th>Shift</th><th>Volunteer</th><th>Start</th><th class="n">Hours</th><th>Status</th></tr></thead><tbody>
          ${order.map(k => groups.get(k).sort((a, b) => (a.start?.getTime() || 0) - (b.start?.getTime() || 0) || norm(a.name).localeCompare(norm(b.name))).map((s, i) => `<tr>${i === 0 ? `<td rowspan="${groups.get(k).length}"><b>${k === '…' ? '<span class="muted">checking…</span>' : esc(k)}</b>${k !== '…' && defById.size ? `<div class="muted" style="font-size:11.5px">${[...defById.values()].filter(x => x.name === k).map(x => `${x.booked}${x.max !== null ? '/' + x.max : ''} booked`).join('')}</div>` : ''}</td>` : ''}<td>${esc(s.name)}</td><td>${esc(fmtDT(s.start))}</td><td class="n">${s.hours || ''}</td><td>${statusPill(s.status)}${/pending/i.test(s.status) ? ` <button class="btn ap-go" data-approve="${esc(title)}" title="Open this event's pending shifts on the Hours tab">Approve…</button>` : ''}</td></tr>`).join('')).join('')}
        </tbody></table></div>` : ''}`;
        // Pending rows jump to the Hours tab filtered to this event so you can
        // approve an event right after looking at who was actually on it.
        box.querySelectorAll('[data-approve]').forEach(b => b.addEventListener('click', () => { state.pendingSearch = b.dataset.approve; state.tab = 'hours'; state.q = ''; render(); }));
      };
      paint();
      // now read the forms we havent seen and repaint as they land
      const todo = d.shifts.filter(s => !Schedule.formCache.has(s.id)).map(s => s.id);
      if (todo.length) {
        if (!pubCache.has(id)) { const pid = (await VMS.publicIdsFor([id]).catch(() => new Map())).get(id); pubCache.set(id, pid ? await VMS.publicEvent(pid).catch(() => null) : null); const p2 = pubCache.get(id); defById.clear(); (p2 && p2.shifts ? p2.shifts : []).forEach(x => defById.set(norm(x.id), x)); }
        let done = 0, i = 0;
        await Promise.all(Array.from({ length: 3 }, async () => { while (i < todo.length) { const bid = todo[i++]; await Schedule.roleFromForm(bid); done++; if (state.openEvent !== id || !stillCurrent('events')) return; const n = box.querySelector('#d7-shiftprog'); if (n) n.textContent = ` checking booked shifts… ${done} of ${todo.length}`; if (done % 3 === 0 || done === todo.length) paint(); } }));
        if (state.openEvent === id && stillCurrent('events')) paint();
      }
    } catch (e) { box.innerHTML = `<div class="err">${esc(e.message || e)}</div>`; }
  }
  const isCancelledStatus = s => /cancel/i.test(s || '');
  const CSS_ID = s => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  TABS.push({ id: 'events', label: 'Events', render: renderEvents });

  // ---- Schedule ----
  // The spreadsheet, as far as VMS can fill it in. Month at a time. Copy it,
  // download it, print it. The rows paint as soon as the events are in and the
  // MFR / Apprentice columns tidy themselves up as the booking forms come back.
  const SC = { rows: null, loading: false, progress: '', error: null, token: 0, flash: '' };
  if (!state.schedY) { const t = Schedule.today(); state.schedY = t.year; state.schedM = t.month; }

  async function renderSchedule() {
    const token = ++SC.token;
    SC.rows = null; SC.error = null; SC.loading = true; SC.progress = 'Reading events…';
    paintSchedule();
    const y = state.schedY, m = state.schedM;
    try {
      const rows = await Schedule.monthRows(y, m, { onProgress: p => { if (token !== SC.token) return; SC.progress = p.phase === 'events' ? (p.total ? `Reading events… ${p.done} of ${p.total}` : 'Reading events…') : ''; schedProgress(); } });
      if (token !== SC.token || !stillCurrent('schedule')) return;
      SC.rows = rows; SC.loading = false; SC.progress = '';
      paintSchedule();
      // second pass: the booked shift for everyone, straight from VMS
      await Schedule.resolveRoles(rows, {
        onProgress: p => { if (token !== SC.token) return; SC.progress = p.total ? `Checking who booked which shift with VMS… ${p.done} of ${p.total}` : ''; schedProgress(); },
        onRow: r => { if (token === SC.token && stillCurrent('schedule')) schedRowDom(r); },
      });
      if (token !== SC.token || !stillCurrent('schedule')) return;
      SC.progress = ''; schedProgress(); schedToolbar();
    } catch (e) {
      if (token !== SC.token || !stillCurrent('schedule')) return;
      SC.error = e.message || String(e); SC.loading = false; paintSchedule();
    }
  }
  function schedProgress() { const n = main && main.querySelector('#sc-progress'); if (n) { n.textContent = SC.progress; n.hidden = !SC.progress; } }

  // --- painting
  const scLabel = () => Schedule.monthLabel(state.schedY, state.schedM);
  function paintSchedule() {
    if (!stillCurrent('schedule') || !main) return;
    const rows = SC.rows || [];
    const q = state.q || '';
    const shown = rows.filter(r => matches(q, r.event.title, r.event.locationName, r.people.map(p => p.name).join(' '), r.contact && r.contact.name));
    main.innerHTML = `<div class="wrap sc-wrap">
      <div class="bar">
        <div class="seg"><button data-nav="-1" title="Previous month">‹</button><button data-nav="0">This month</button><button data-nav="1" title="Next month">›</button></div>
        <h2 class="sc-h">${esc(scLabel())}</h2>
        <span class="sp"></span>
        <input type="search" placeholder="Filter by event, place or name…" value="${esc(q)}">
      </div>
      <div class="bar sc-tools">
        <button class="btn" id="sc-copy" ${rows.length ? '' : 'disabled'} title="Copies the month as rows you can paste straight into the sheet">Copy month for spreadsheet</button>
        <button class="btn" id="sc-xlsx" ${rows.length ? '' : 'disabled'}>Download .xlsx</button>
        <button class="btn" id="sc-print" ${rows.length ? '' : 'disabled'}>Print</button>
        <span class="sc-flash" id="sc-flash">${esc(SC.flash)}</span>
        <span class="sp"></span>
        <span class="muted sc-progress" id="sc-progress" ${SC.progress ? '' : 'hidden'}>${esc(SC.progress)}</span>
      </div>
      ${SC.error ? `<div class="err"><b>Couldn't build the schedule.</b> ${esc(SC.error)}</div>` : ''}
      ${SC.loading && !SC.error ? `<div class="load">${esc(SC.progress || 'Loading…')}</div>` : ''}
      ${!SC.loading && !SC.error && !shown.length ? `<div class="card muted">${rows.length ? 'Nothing matches that filter.' : `No D0007 events in ${esc(scLabel())}.`}</div>` : ''}
      ${shown.length ? `<div class="tbl sc-tbl"><table class="sc-table"><thead><tr>
          <th class="sc-ev">Event</th><th>Date</th><th>Meet @ St.John</th><th>Approx. End</th><th>Shifts</th><th>Location</th><th>On-site contact</th><th>Medical First Responders</th><th>Apprentice</th><th>Quals</th>
        </tr></thead><tbody>${schedBody(shown)}</tbody></table></div>
        <p class="muted sc-foot">Meet @ St.John is the shift start in VMS. Copy / download put the sheet's 12 columns in order and leave Meet @ Event, Event Notes (except partial-shift lines), Equipment and Vehicle blank - VMS has nothing for them. Names marked * have a shift that differs from the main one; the note says how. No-shows and waitlisted people are shown here but kept out of the export.</p>` : ''}
    </div>`;
    bindSchedule();
  }
  function schedBody(rows) {
    let prev = null, html = '';
    for (const r of rows) {
      if (prev && prev !== r.date) html += '<tr class="sc-gap"><td colspan="10"></td></tr>';
      html += schedRowHTML(r); prev = r.date;
    }
    return html;
  }
  const scTime = d => d ? Schedule.hm(d) : '';
  function schedRowHTML(r) {
    return `<tr class="sc-row" data-key="${esc(r.key)}">${schedCells(r)}</tr>`;
  }
  function schedCells(r) {
    const ev = r.event, st = r.staffing;
    const person = p => `<div class="sc-p${isNoShowOrWait(p.status) ? ' sc-out' : ''}"><span>${esc(p.name)}${p.partial ? '<b>' + esc(p.partial.nameMark) + '</b>' : ''}</span>${p.partial ? `<span class="muted"> · ${esc(p.partial.text)}</span>` : ''}${isNoShowOrWait(p.status) ? ` ${statusPill(p.status)}` : ''}${p.roleSource === 'cert' ? ' <span class="sc-cert" title="From certifications - VMS hasn\'t confirmed the booked shift yet">cert</span>' : ''}</div>`;
    // each shift definition of this kind as its own block: "MFR day 3 · 16:00–23:00 · 3/10" then the names under it
    const names = kind => {
      const gs = (r.groups || []).filter(g => g.kind === kind);
      if (!gs.length) return '<span class="muted">—</span>';
      return gs.map(g => `<div class="sc-grp"><div class="sc-grph"><b>${esc(g.name)}</b>${g.def ? `<span class="muted"> ${esc(scTime(g.def.start))}–${esc(scTime(g.def.end))}${g.def.max !== null ? ` · ${g.def.booked}/${g.def.max}` : ''}</span>` : ''}</div>${g.people.map(person).join('') || '<div class="muted">nobody yet</div>'}</div>`).join('');
    };
    const defs = r.defs.length ? r.defs.map(d => `<div class="sc-def"><b>${esc(d.name)}</b> ${esc(scTime(d.start))}–${esc(scTime(d.end))}${d.max !== null ? ` · <span class="n">${d.booked}/${d.max}</span>` : ` · ${d.booked} booked`}${d.needed > 0 ? ` ${pill(`${d.needed} needed`, 'red')}` : d.needed !== null && d.needed < 0 ? ` ${pill(`over by ${-d.needed}`, 'amber')}` : ''}</div>`).join('') : '<span class="muted">No shift definitions on the public page</span>';
    const addr = ev.address ? [ev.address.street, [ev.address.city, ev.address.province].filter(Boolean).join(', ') + (ev.address.postal ? `  ${ev.address.postal}` : '')].filter(x => x && x.trim()) : [];
    const contact = r.contact ? `<div><b>${esc(r.contact.name || '')}</b></div>${r.contact.phone ? `<div><a href="tel:${esc(r.contact.phone)}">${esc(r.contact.phone)}</a></div>` : ''}${r.contact.email ? `<div><a href="mailto:${esc(r.contact.email)}">${esc(r.contact.email)}</a></div>` : ''}${r.organizer && r.organizer.organization ? `<div class="muted">${esc(r.organizer.organization)}</div>` : ''}${r.request && r.request.onSite ? `<div class="muted sc-onsite" title="From the event request: what the organizer says is on site">${esc(onSiteText(r.request.onSite))}</div>` : ''}`
      : '<span class="muted" title="The organizer contact lives on the event request. VMS only shows requests to a group lead while they are waiting for approval; once the event is approved it hides them.">Not shown by VMS once the event is approved</span>';
    const staff = st && st.known ? `<div class="sc-staff">${st.level === 'ok' ? pill('Covered', 'green') : ''}${st.problems.map(p => pill(p, st.level === 'short' ? 'red' : 'amber')).join(' ')}<span class="muted"> ${st.mfr.booked} MFR${st.mfr.booked === 1 ? '' : 's'} · ${st.app.booked} apprentice${st.app.booked === 1 ? '' : 's'}</span></div>` : '';
    return `
      <td class="sc-ev"><div class="sc-title">${esc(ev.title)}</div><div class="muted">${esc(ev.program || '')} ${statusPill(ev.status)}</div>${ev.description ? `<div class="muted sc-desc">${esc(ev.description)}</div>` : ''}${staff}<div class="sc-links"><a href="${esc(ev.link)}" target="_blank" rel="noopener">Open in VMS ↗</a>${ev.publicLink ? ` · <a href="${esc(ev.publicLink)}" target="_blank" rel="noopener">Public page ↗</a>` : ''}</div></td>
      <td class="sc-date">${esc(r.dateLabel)}</td>
      <td class="n">${esc(r.meetSJ)}</td>
      <td class="n">${esc(r.approxEnd)}</td>
      <td>${defs}</td>
      <td><div><b>${esc(ev.locationName || '')}</b></div>${addr.map(a => `<div>${esc(a)}</div>`).join('')}</td>
      <td>${contact}</td>
      <td>${names('MFR')}${r.noShift.length ? `<div class="muted sc-noshift">Signed up, no shift: ${esc(r.noShift.join(', '))}</div>` : ''}</td>
      <td>${names('Apprentice')}</td>
      <td>${r.quals.length ? r.quals.map(q => pill(q, 'grey')).join(' ') : '<span class="muted">—</span>'}</td>`;
  }
  const isNoShowOrWait = s => /no.?show|wait ?list/i.test(s || '');
  const onSiteText = o => { const yes = Object.entries({ firstAidRoom: 'first aid room/tent', volunteerArea: 'volunteer area', water: 'water', food: 'food for volunteers', parking: 'parking', bathrooms: 'bathrooms', shade: 'shade', power: 'power', cellReception: 'cell reception', otherAgencies: 'EMS/police on site' }).filter(([k]) => o[k]).map(([, v]) => v); return yes.length ? 'On site: ' + yes.join(', ') : ''; };
  function schedRowDom(r) {
    const tr = main && main.querySelector(`tr.sc-row[data-key="${CSS.escape ? CSS.escape(r.key) : r.key}"]`);
    if (tr) tr.innerHTML = schedCells(r);
  }

  // --- toolbar
  function schedToolbar() { ['sc-copy', 'sc-xlsx', 'sc-print'].forEach(id => { const b = main.querySelector('#' + id); if (b) b.disabled = !(SC.rows && SC.rows.length); }); }
  function schedFlash(text) { SC.flash = text; const n = main.querySelector('#sc-flash'); if (n) n.textContent = text; setTimeout(() => { if (SC.flash === text) { SC.flash = ''; const m = main.querySelector('#sc-flash'); if (m) m.textContent = ''; } }, 4000); }
  async function copySchedule() {
    const tsv = Schedule.toTSV(SC.rows);
    let ok = false;
    try { await navigator.clipboard.writeText(tsv); ok = true; } catch (e) { /* no clipboard permission - fall through */ }
    if (!ok) { const ta = el('textarea', { style: 'position:fixed;left:-9999px;top:0' }); ta.value = tsv; document.body.appendChild(ta); ta.select(); try { ok = document.execCommand('copy'); } catch (e) { /* nothing */ } ta.remove(); }
    schedFlash(ok ? `Copied ${SC.rows.length} row${SC.rows.length === 1 ? '' : 's'} - paste into the sheet` : 'Copy failed - try Download .xlsx instead');
  }
  function downloadXLSX() {
    const bytes = Schedule.toXLSX(SC.rows, { sheetName: scLabel().split(' ')[0] });
    const a = el('a', { href: URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })), download: `Event Schedule ${scLabel()}.xlsx` });
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function bindSchedule() {
    main.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => {
      const n = +b.dataset.nav;
      if (n === 0) { const t = Schedule.today(); state.schedY = t.year; state.schedM = t.month; }
      else { let m = state.schedM + n, y = state.schedY; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; } state.schedM = m; state.schedY = y; }
      render();
    }));
    const inp = main.querySelector('input[type=search]'); if (inp) inp.addEventListener('input', () => { state.q = inp.value; const tb = main.querySelector('.sc-table tbody'); const rows = (SC.rows || []).filter(r => matches(state.q, r.event.title, r.event.locationName, r.people.map(p => p.name).join(' '), r.contact && r.contact.name)); if (tb) tb.innerHTML = schedBody(rows); else paintSchedule(); });
    main.querySelector('#sc-copy')?.addEventListener('click', copySchedule);
    main.querySelector('#sc-xlsx')?.addEventListener('click', downloadXLSX);
    main.querySelector('#sc-print')?.addEventListener('click', () => { document.documentElement.classList.add('d7-print'); const done = () => { document.documentElement.classList.remove('d7-print'); window.removeEventListener('afterprint', done); }; window.addEventListener('afterprint', done); setTimeout(() => window.print(), 50); });
  }

  CSS_PARTS.push(`
#d0007-root .sc-h{font-size:17px;margin:0 6px}
#d0007-root .sc-tools{margin-top:-4px}
#d0007-root .sc-flash{font-size:12.5px;color:#1f5a2c;min-height:18px}
#d0007-root .sc-progress{font-size:12.5px}
#d0007-root .sc-tbl{max-height:none}
#d0007-root .sc-table{min-width:1500px;table-layout:fixed}
#d0007-root .sc-table th,#d0007-root .sc-table td{font-size:12.5px;vertical-align:top;white-space:normal}
#d0007-root .sc-table th.sc-ev,#d0007-root .sc-table td.sc-ev{position:sticky;left:0;background:#fff;z-index:2;width:260px;box-shadow:2px 0 0 #e7ebe7}
#d0007-root .sc-table th.sc-ev{z-index:3;background:#f7f9f7}
#d0007-root .sc-table th:nth-child(2),#d0007-root .sc-table td:nth-child(2){width:86px}
#d0007-root .sc-table th:nth-child(3),#d0007-root .sc-table th:nth-child(4){width:72px}
#d0007-root .sc-table th:nth-child(5){width:230px}
#d0007-root .sc-table th:nth-child(6){width:200px}
#d0007-root .sc-table th:nth-child(7){width:200px}
#d0007-root .sc-table th:nth-child(8),#d0007-root .sc-table th:nth-child(9){width:190px}
#d0007-root .sc-table th:nth-child(10){width:120px}
#d0007-root .sc-title{font-weight:600;font-size:14px}
#d0007-root .sc-desc{font-size:12px;margin-top:2px}
#d0007-root .sc-links{font-size:12px;margin-top:4px}
#d0007-root .sc-staff{margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;align-items:center}
#d0007-root .sc-def{white-space:nowrap}
#d0007-root .sc-grp{margin-bottom:8px}
#d0007-root .sc-grp:last-child{margin-bottom:0}
#d0007-root .sc-grph{font-size:12px;border-bottom:1px solid #e7ebe7;margin-bottom:3px;white-space:nowrap}
#d0007-root .sc-p{line-height:1.5}
#d0007-root .sc-p b{color:#9a2b1d;margin-left:1px}
#d0007-root .sc-out{opacity:.6}
#d0007-root .sc-cert{font-size:10px;color:#8a5a00;background:#fdeccd;border-radius:3px;padding:0 4px;vertical-align:middle}
#d0007-root .sc-noshift{font-size:11.5px;margin-top:6px}
#d0007-root .sc-onsite{font-size:11.5px;margin-top:4px}
#d0007-root .sc-gap td{height:6px;background:#eef1ee;padding:0;border:0}
#d0007-root .sc-foot{font-size:12px;margin-top:8px}
@media print{
  html.d7-print body > :not(#d0007-root){display:none!important}
  html.d7-print #d0007-root{position:static;height:auto;overflow:visible;display:block;background:#fff;font-size:10px}
  html.d7-print #d0007-root header,html.d7-print #d0007-root nav,html.d7-print #d0007-root footer,html.d7-print #d0007-root .seg,html.d7-print #d0007-root .btn,html.d7-print #d0007-root input,html.d7-print #d0007-root .sc-flash,html.d7-print #d0007-root .sc-foot,html.d7-print #d0007-root .sc-links,html.d7-print #d0007-root .sc-progress{display:none!important}
  html.d7-print #d0007-root main{overflow:visible;padding:0}
  html.d7-print #d0007-root .sc-h:before{content:"Event Schedule - "}
  html.d7-print #d0007-root .sc-tbl{max-height:none;overflow:visible;border:0;border-radius:0}
  html.d7-print #d0007-root .sc-table{min-width:0;width:100%;table-layout:auto}
  html.d7-print #d0007-root .sc-table th,html.d7-print #d0007-root .sc-table td{position:static;font-size:9px;padding:3px 4px;border:1px solid #cfd8d0;-webkit-print-color-adjust:exact;print-color-adjust:exact;box-shadow:none}
  html.d7-print #d0007-root .sc-table thead{display:table-header-group}
  html.d7-print #d0007-root .sc-table tr{break-inside:avoid;page-break-inside:avoid}
  @page{size:landscape;margin:10mm}
}
`);
  TABS.push({ id: 'schedule', label: 'Schedule', render: renderSchedule });

  // ---- Roster ----
  // The volunteers page in the portal is a 10-row paginated table with a csv
  // button. This is the csv, on screen, searchable, with hours and certs a
  // click away. Revolutionary stuff.
  //
  // "MFR" here means VMS has a current Medical First Responder cert on file for
  // the person (any of the MFR qualification names). Same test the Schedule tab
  // falls back on when it cant tell which shift someone booked.
  function mfrCertOf(name, certs) {
    const mine = certs.filter(c => norm(c.name) === norm(name) && /medical first responder/i.test(c.qualification) && c.expiry && daysUntil(c.expiry) >= 0);
    return mine.sort((a, b) => (toDate(b.expiry)?.getTime() || 0) - (toDate(a.expiry)?.getTime() || 0))[0] || null;
  }
  async function renderRoster() {
    const [roster, certs] = await Promise.all([VMS.roster(), VMS.certifications().catch(() => [])]);
    if (!stillCurrent('roster')) return;
    roster.forEach(r => { const c = mfrCertOf(r.name, certs); r.mfr = c ? 'MFR' : 'Apprentice'; r.mfrTo = c ? c.expiry : ''; });
    const q = state.q;
    const rows = sortRows(roster.filter(r => matches(q, r.name, r.email, r.phone, r.contactId, r.status, r.mfr)), 'roster', 'name');
    const active = roster.filter(r => /active/i.test(r.status)).length;
    const sel = state.rosterSel && roster.find(r => r.contactId === state.rosterSel);
    main.innerHTML = `<div class="wrap">
      <div class="stats"><div class="stat"><b>${roster.length}</b><span>members in group</span></div><div class="stat"><b>${active}</b><span>active</span></div><div class="stat"><b>${roster.filter(r => r.mfr === 'MFR').length}</b><span>with a current MFR cert</span></div><div class="stat"><b>${roster.filter(r => r.mfr !== 'MFR').length}</b><span>apprentice / no MFR cert on file</span></div></div>
      <div class="bar"><input type="search" placeholder="Search name, email, phone, ID…" value="${esc(q)}"><button class="btn" id="d7-csv">Download CSV</button></div>
      <div class="two"><div class="tbl"><table><thead><tr>${th('Name', 'name', 'roster', 'name')}${th('MFR cert', 'mfr', 'roster', 'name')}${th('Email', 'email', 'roster', 'name')}${th('Phone', 'phone', 'roster', 'name')}${th('Status', 'status', 'roster', 'name')}${th('ID', 'contactId', 'roster', 'name')}</tr></thead><tbody>
        ${rows.map(r => `<tr class="row" data-sel="${esc(r.contactId)}"><td>${esc(r.name)}</td><td>${r.mfr === 'MFR' ? pill('MFR', 'green') + ` <span class="muted">to ${esc(fmtD(r.mfrTo))}</span>` : pill('Apprentice', 'grey')}</td><td><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></td><td><a href="tel:${esc(r.phone)}">${esc(r.phone)}</a></td><td>${statusPill(r.status)}</td><td class="muted">${esc(r.contactId)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="side" id="d7-side">${sel ? '<div class="load">Loading…</div>' : '<span class="muted">Select a member to see their hours and certifications.</span>'}</div></div>
    </div>`;
    const inp = main.querySelector('input[type=search]'); inp.addEventListener('input', () => { state.q = inp.value; renderRoster(); });
    bindSort(main, renderRoster);
    main.querySelectorAll('tr[data-sel]').forEach(tr => tr.addEventListener('click', () => { state.rosterSel = tr.dataset.sel; renderRoster(); }));
    main.querySelector('#d7-csv').addEventListener('click', () => downloadCSV('d0007-roster.csv', ['Name', 'MFR cert', 'MFR cert expiry', 'Email', 'Phone', 'Status', 'Contact ID'], rows.map(r => [r.name, r.mfr, r.mfrTo, r.email, r.phone, r.status, r.contactId])));
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
  D.mfrCertOf = mfrCertOf;

  // ---- Hours ----
  // Two things here. Top is the pending approval queue, the one place this
  // script writes to VMS (mechanics in 22-approve.js). Under it, collapsed, is
  // the hours report that used to be this whole tab.
  //
  // Nothing gets written until you press Submit, read the list of exactly
  // whats going to change, and press Confirm. Each rows start/end/hours come
  // from the shifts own approval form (read when you first touch the row), not
  // from the list page, so what you see is what gets sent. I've been burned by
  // the list page rounding before.
  const AP = { list: null, total: 0, truncated: false, progress: '', error: null, rows: new Map(), closed: new Set(), confirm: null, running: null, lastRun: null, reportOpen: false, loadToken: 0, evHours: {}, reportRows: [] };
  const AP_STATUSES = [[Approvals.STATUS.APPROVED, 'Approve'], [Approvals.STATUS.NO_SHOW, 'No show'], [Approvals.STATUS.CANCELLED, 'Cancel'], [Approvals.STATUS.PENDING, 'Leave pending']];
  const AP_SPIN = ' <span class="ap-spin" title="Reading the shift from VMS…"></span>';

  const apRow = item => ({ id: item.shiftId, item, form: null, formLoading: false, formError: null, formPromise: null, sel: false, status: Approvals.STATUS.APPROVED, edits: {}, timesOpen: false, result: null });
  // Until the form has been read the list pages start and hours stand in.
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

  // Entry from the tab bar or Refresh - start over (unless a batch is running).
  async function renderHours() {
    if (AP.running) { await paintHours(); return; }   // a batch is mid-flight; just show it
    Object.assign(AP, { list: null, error: null, confirm: null, running: null, rows: new Map(), progress: '' });
    await apLoad();
  }
  // keepRows keeps your selections, edits and results for shifts still pending
  // (used after a run and by Reload). quiet leaves the current list on screen
  // while the new one comes in instead of flashing a spinner at you.
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
      for (const it of list) { const old = keepRows && prev.get(it.shiftId); AP.rows.set(it.shiftId, old ? { ...old, item: it, form: null, formLoading: false, formPromise: null } : apRow(it)); }
      // (edits and selection carry over; the form snapshot doesn't, so the next touch reads it fresh)
    } catch (e) { if (token !== AP.loadToken) return; AP.error = e.message || String(e); AP.progress = ''; }
    await paintHours();
  }

  // --- the shift form, read lazily, three at a time ---
  // Each one is a ~60KB page for four numbers. Three at a time keeps the
  // portal from getting grumpy.
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
    const hidden = apSelected().filter(r => !matches(state.pendingSearch || '', r.item.name, r.item.event)).length;
    return `<div class="ap-actions" id="ap-actions"><b id="ap-count">${n} selected${hidden ? ` (${hidden} hidden by the filter)` : ''}</b><span class="sp"></span>
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

  // In-place updates so typing in one row doesnt repaint the whole screen and
  // throw your cursor away.
  function apRowDom(r, { keepHours = false } = {}) {
    if (AP.rows.get(r.id) !== r) return;   // an older copy of this row (a reload happened); its DOM isn't ours
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
    const hidden = apSelected().filter(r => !matches(state.pendingSearch || '', r.item.name, r.item.event)).length;
    const c = main.querySelector('#ap-count'); if (c) c.textContent = `${n} selected${hidden ? ` (${hidden} hidden by the filter)` : ''}`;
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

  // --- submit -> confirm -> run ---
  // Yes, two steps. Its 143 peoples hours.
  async function apBeginConfirm() {
    const sel = apSelected(); if (!sel.length || apBusy()) return;
    AP.confirm = { loading: true, items: [] };
    await paintHours();
    // Always re-read the forms here. The panel has to describe VMS as it is
    // right now, not as it was when you first clicked the row ten minutes ago.
    sel.forEach(r => { r.form = null; r.formError = null; });
    await Promise.all(sel.map(apEnsureForm));
    if (!AP.confirm || !AP.confirm.loading) return;   // cancelled meanwhile
    AP.confirm = { loading: false, items: sel.map(r => {
      if (!r.form) return { r, err: 'Couldn\'t read the shift form: ' + (r.formError || 'unknown error') };
      if (r.form.status !== Approvals.STATUS.PENDING) return { r, err: `Already ${Approvals.STATUS_LABEL[r.form.status] || r.form.status} in VMS` };
      if (r.form.participation && !norm(r.form.participation).startsWith(norm(r.item.name))) return { r, err: `The form is for "${r.form.participation}", not this row` };
      try {
        const p = Approvals.plan(r.form, { ...r.edits, status: r.status });
        const same = (a, b) => (!a && !b) || (a && b && a.getTime() === b.getTime());
        const noop = p.status === r.form.status && p.hours === r2(r.form.hours) && same(p.start, r.form.start) && same(p.end, r.form.end);
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
    const res = await Approvals.run(items.map(i => ({ shiftId: i.r.id, values: i.plan, row: i.r, expect: { status: Approvals.STATUS.PENDING, start: i.r.form.start, end: i.r.form.end, hours: i.r.form.hours, name: i.r.item.name } })), {
      onProgress: (idx, result) => {
        const r = items[idx].r; r.result = result; if (AP.running) AP.running.i = idx + 1;
        apRowDom(r);
        const n = main.querySelector('#ap-run .ap-run-n'); if (n) n.textContent = `${idx + 1} of ${items.length}`;
        const bar = main.querySelector('#ap-run .track i'); if (bar) bar.style.width = `${Math.round(100 * (idx + 1) / items.length)}%`;
      },
    });
    AP.running = null;
    AP.lastRun = { at: new Date(), done: res.done.map(d => ({ name: d.row.item.name, event: d.row.item.event, values: d.values })), failed: res.failed.map(f => ({ name: f.row.item.name, event: f.row.item.event, error: f.error })) };
    // Done ones leave the queue now, the reload below is the real check.
    for (const d of res.done) AP.rows.delete(d.shiftId);
    AP.list = AP.list.filter(it => AP.rows.has(it.shiftId));
    for (const f of res.failed) { const r = AP.rows.get(f.shiftId); if (r) { r.sel = true; r.form = null; } }   // re-read the form before any retry
    await paintHours();
    apLoad({ keepRows: true, quiet: true });
  }

  // --- the hours report (unchanged, just folded under a toggle) ---
  // Reports > Volunteer Hours in the portal is 10 rows a page with no totals.
  // This adds the totals. Thats it. Thats the feature.
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
  // For a first response unit this is the one that matters - someone with a
  // lapsed MFR cert cant deploy, full stop. VMS has no "show me everyones
  // current certs" view anywhere. It has five windowed reports with labels that
  // dont match what they do (see 20-vms.js). This pulls all five and flags
  // whats expired, whats about to, and whats fine.
  function certState(expiry) { if (!expiry) return 'none'; const d = daysUntil(expiry); if (d === null) return 'none'; return d < 0 ? 'expired' : d <= CERT_WARN_DAYS ? 'expiring' : 'current'; }
  function certPill(expiry) { const s = certState(expiry); const d = daysUntil(expiry); return s === 'expired' ? pill(`Expired ${fmtD(expiry)}`, 'red') : s === 'expiring' ? pill(`Expires in ${d} d`, 'amber') : s === 'current' ? pill(`Valid to ${fmtD(expiry)}`, 'green') : pill('No expiry', 'grey'); }
  async function renderCerts() {
    const certs = (await VMS.certifications()).map(c => ({ ...c, state: certState(c.expiry), expD: toDate(c.expiry), effD: toDate(c.effective) }));
    if (!stillCurrent('certs')) return;
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
  // Full screen overlay on top of the portal page. Esc or Close puts the
  // portal back exactly as it was.
  function addStyles() { if (!document.getElementById('d0007-css')) document.head.appendChild(el('style', { id: 'd0007-css' }, CSS_PARTS.join('\n'))); }
  let saidHello = false;
  function open() {
    if (root) { root.style.display = 'flex'; return; }
    if (!saidHello) { saidHello = true; try { console.info("Cam's VMS Console - built out of spite, mostly. Cam Prosic, Deputy Chief Ops, SJA Hamilton D0007."); } catch (e) { /* no console, no problem */ } }
    addStyles();
    root = el('div', { id: 'd0007-root', role: 'dialog', 'aria-label': APP_TITLE });
    root.innerHTML = `<header><h1>${esc(APP_TITLE)}</h1><span class="sp"></span><button class="btn" id="d7-refresh" title="Re-fetch everything from VMS">Refresh</button><button class="btn" id="d7-close">Close ✕</button></header>
      <nav>${TABS.map(t => `<button data-tab="${t.id}">${esc(t.label)}</button>`).join('')}</nav>
      <main></main>
      <footer>Live from your VMS session. Only the Hours tab writes anything back. Times in Eastern.</footer>`;
    document.body.appendChild(root);
    main = root.querySelector('main');
    root.querySelector('#d7-close').addEventListener('click', close);
    root.querySelector('#d7-refresh').addEventListener('click', () => { VMS.clear(); render(); });
    root.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; state.q = ''; render(); }));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && root && root.style.display !== 'none') close(); });
    render();
  }
  function close() { if (root) root.style.display = 'none'; }

  W.D0007 = Object.assign({ open, close, render, state, version: '0.3.1' }, D);

  // Floating launcher button. Skip it inside iframes (the portal loads its
  // entity forms in modal iframes and the script would run in there too).
  // Styles go in first - 0.1.1 only added them when the console opened, so on
  // Safari the button was a plain grey <button> at the very bottom of the page
  // and I spent twenty minutes thinking Teampermonkey wasnt running at all.
  if (window.top === window.self && document.body) {
    addStyles();
    const b = el('button', { id: 'd0007-launch', type: 'button', title: APP_TITLE }, 'VMS');
    b.addEventListener('click', open);
    document.body.appendChild(b);
    if (location.hash === '#d0007') open();
  }
  // Second way in, from the Tampermonkey icon menu, for when the button is
  // hidden behind something or I've broken the css again.
  if (typeof GM_registerMenuCommand === 'function') {
    try { GM_registerMenuCommand("Open Cam's VMS Console", open); } catch (e) { }
  }
})();
