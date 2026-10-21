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
