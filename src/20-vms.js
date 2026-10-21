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
