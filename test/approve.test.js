// Approvals: the pending list, the approval form, and the postback.
const SHIFT = '5aad352a-4685-f111-ab0e-7ced8da56148';   // the record the form fixture is for
const P = 'ctl00$ContentContainer$MainContent$EntityFormControl$EntityFormControl_EntityFormView$';
const html = body => `<!doctype html><html><head></head><body>${body}</body></html>`;
const isPost = (u, o) => u.includes('/_portal/modal-form-template-path/') && (o.method || 'GET').toUpperCase() === 'POST';
const isFormGet = (u, o) => u.includes('/_portal/modal-form-template-path/') && (o.method || 'GET').toUpperCase() === 'GET';
const wait = ms => new Promise(r => setTimeout(r, ms));
// Values from the script live in jsdom's realm, so deepStrictEqual sees different prototypes. Compare by JSON.
const same = (assert, a, b, msg) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);

module.exports = {
  async 'registers with constants and both drivers'({ D0007, assert }) {
    const A = D0007.Approvals;
    assert.strictEqual(A.STATUS.APPROVED, '335940001');
    assert.strictEqual(A.STATUS_LABEL[A.STATUS.NO_SHOW], 'No Show');
    assert.ok(typeof A.drivers.iframe === 'function' && typeof A.drivers.fetch === 'function');
    assert.strictEqual(A.defaultDriver, 'iframe');
  },

  async 'pending() walks the hours pages and parses the inline js'({ D0007, assert, isDate, fetchLog }) {
    const A = D0007.Approvals;
    fetchLog.length = 0;
    const pages = [];
    const list = await A.pending({ onPage: p => pages.push(p) });
    assert.strictEqual(list.length, 3);
    for (const it of list) {
      assert.ok(it.name.startsWith('Test Volunteer'), it.name);
      assert.ok(typeof it.hours === 'number' && it.hours > 0, 'hours numeric');
      assert.ok(isDate(it.start), 'start is a date');
      assert.match(it.shiftId, /^[0-9a-f-]{36}$/);
      assert.ok(it.event);
    }
    // sorted by event, and the GMT date parsed as GMT
    same(assert, list.map(i => i.event), ['Because Beer', 'Liberty and Unity Basketball Game', 'Oakville latino festival']);
    assert.strictEqual(list[2].start.toISOString(), '2026-07-26T16:00:00.000Z');
    assert.strictEqual(list[2].hours, 5);
    // page 1 said 143 records, so it went on to fetch the other 14 pages
    const hoursFetches = fetchLog.filter(l => l.url.includes('/en-US/group-lead/hours/'));
    assert.strictEqual(hoursFetches.length, 15);
    assert.ok(hoursFetches[0].url.includes('fetchPage=1'));
    assert.ok(hoursFetches.some(l => l.url.includes('fetchPage=15')));
    assert.strictEqual(pages[pages.length - 1].total, 143);
    assert.strictEqual(pages[pages.length - 1].loaded, 3);
  },

  async 'pending() passes the search through and dedupes'({ D0007, assert, mock, fx }) {
    const A = D0007.Approvals;
    // same three rows on every page: should collapse to three
    mock.override(u => u.includes('/en-US/group-lead/hours/'), (u, o, res) => res(html(`<script>${fx('hoursPage.js').replace('143', '20')}</script>`)));
    mock.log.length = 0;
    const list = await A.pending({ search: 'Beer' });
    assert.strictEqual(list.length, 3);
    const urls = mock.log.filter(l => l.url.includes('/en-US/group-lead/hours/')).map(l => l.url);
    assert.strictEqual(urls.length, 2);
    assert.ok(urls.every(u => u.includes('fetchSearch=Beer')));
    mock.clear();
  },

  async 'parseHoursPage copes with escaped quotes and entities'({ D0007, assert }) {
    const A = D0007.Approvals;
    const js = `var totalRecordCount = 1;\nshiftId = "abc";\norigStartDate = "Sat, 11 Jul 2026 17:30:00 GMT";\nstartDateInEST = SetDateToEST(origStartDate);\nvolunteerName = "O\\"Brien, Pat &amp; Co";\neventName = "Because Beer";\nactionButton = buildActionButton(shiftId);\n$("#pendingShiftsTable").append("<tr><td>" + volunteerName + "</td><td>" + eventName + "</td><td>" + startDateInEST + "</td><td>2.5</td><td aria-label='action menu'>" + actionButton + "</tr></tr>");`;
    const r = A.parseHoursPage(html(`<script>${js}</script>`));
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.items[0].name, 'O"Brien, Pat & Co');
    assert.strictEqual(r.items[0].hours, 2.5);
  },

  async 'loadForm() reads the approval form'({ D0007, assert, isDate }) {
    const f = await D0007.Approvals.loadForm(SHIFT);
    assert.strictEqual(f.shiftId, SHIFT);
    assert.ok(isDate(f.start) && isDate(f.end));
    assert.strictEqual(f.start.toISOString(), '2026-07-26T16:00:00.000Z');
    assert.strictEqual(f.end.toISOString(), '2026-07-26T21:00:00.000Z');
    assert.strictEqual(f.hours, 5);
    assert.strictEqual(f.status, '335940000');
    assert.strictEqual(f.participation, 'Test Volunteer 91 - Oakville latino festival');
    assert.strictEqual(f.scheduleName, 'Sunday - Shift A - Oakville latino festival');
    same(assert, f.statusOptions.map(o => o.value), ['335940000', '335940001', '335940002', '335940003', '962220001']);
    assert.ok(f.statusOptions.some(o => o.value === '335940001' && o.label === 'Shift Hours Approved'));
  },

  async 'loadForm() refuses a form for a different record'({ D0007, assert }) {
    await assert.rejects(D0007.Approvals.loadForm('00000000-0000-0000-0000-00000000beef'), /different record/);
  },

  async 'plan() derives end from hours and hours from end'({ D0007, assert }) {
    const A = D0007.Approvals;
    const form = { start: new Date('2026-07-26T16:00:00Z'), end: new Date('2026-07-26T21:00:00Z'), hours: 5, status: A.STATUS.PENDING };
    let p = A.plan(form, { hours: 4.5, status: A.STATUS.APPROVED });
    assert.strictEqual(p.end.toISOString(), '2026-07-26T20:30:00.000Z');
    assert.strictEqual(p.hours, 4.5);
    assert.strictEqual(p.status, A.STATUS.APPROVED);
    p = A.plan(form, { end: new Date('2026-07-26T18:20:00Z'), status: A.STATUS.APPROVED });
    assert.strictEqual(p.hours, 2.33, 'rounded to 2 dp');
    assert.strictEqual(p.start.getTime(), form.start.getTime());
    // nothing changed: sent exactly as the form has it
    p = A.plan(form, { status: A.STATUS.APPROVED });
    assert.strictEqual(p.end.getTime(), form.end.getTime()); assert.strictEqual(p.hours, 5);
    // only the start moved: keeps the hours, moves the end
    p = A.plan(form, { start: new Date('2026-07-26T17:00:00Z'), status: A.STATUS.APPROVED });
    assert.strictEqual(p.hours, 5); assert.strictEqual(p.end.toISOString(), '2026-07-26T22:00:00.000Z');
    // rounding of a given value
    assert.strictEqual(A.plan(form, { hours: 1.2345, status: A.STATUS.APPROVED }).hours, 1.23);
    // leave pending with zero hours is allowed; approving it is not
    assert.strictEqual(A.plan(form, { hours: 0, status: A.STATUS.NO_SHOW }).hours, 0);
    assert.throws(() => A.plan(form, { hours: 0, status: A.STATUS.APPROVED }), /zero hours/);
    assert.throws(() => A.plan(form, { hours: -1, status: A.STATUS.NO_SHOW }), /negative/);
    assert.throws(() => A.plan(form, { hours: 25, status: A.STATUS.APPROVED }), /more than a day/);
    assert.throws(() => A.plan(form, { end: new Date('2026-07-26T15:00:00Z'), status: A.STATUS.APPROVED }), /before its start/);
    assert.throws(() => A.plan(form, { status: '1' }), /not a shift status/);
    assert.throws(() => A.plan(form, { hours: 'five', status: A.STATUS.APPROVED }), /must be a number/);
  },

  async 'crm iso round-trips with seven fraction digits'({ D0007, assert }) {
    const A = D0007.Approvals;
    assert.strictEqual(A.toCrmIso(new Date('2026-07-26T16:00:00Z')), '2026-07-26T16:00:00.0000000Z');
    assert.strictEqual(A.toCrmIso(new Date('2026-07-26T16:00:00.750Z')), '2026-07-26T16:00:00.0000000Z', 'milliseconds dropped');
    assert.strictEqual(A.fromCrmIso('2026-07-26T21:00:00.0000000Z').toISOString(), '2026-07-26T21:00:00.000Z');
    assert.strictEqual(A.toCrmIso(A.fromCrmIso('2026-01-05T03:04:05.0000000Z')), '2026-01-05T03:04:05.0000000Z');
    assert.strictEqual(A.fromCrmIso('2026-07-26T12:00:00-04:00').toISOString(), '2026-07-26T16:00:00.000Z');
  },

  async 'eastern datetime-local helpers handle both halves of the year'({ D0007, assert }) {
    const A = D0007.Approvals;
    assert.strictEqual(A.toLocalInput(new Date('2026-07-26T16:00:00Z')), '2026-07-26T12:00');
    assert.strictEqual(A.toLocalInput(new Date('2026-01-10T17:00:00Z')), '2026-01-10T12:00');
    assert.strictEqual(A.toLocalInput(new Date('2026-07-27T03:30:00Z')), '2026-07-26T23:30');
    assert.strictEqual(A.fromLocalInput('2026-07-26T12:00').toISOString(), '2026-07-26T16:00:00.000Z');
    assert.strictEqual(A.fromLocalInput('2026-01-10T12:00').toISOString(), '2026-01-10T17:00:00.000Z');
    assert.strictEqual(A.fromLocalInput('2026-07-26T00:15').toISOString(), '2026-07-26T04:15:00.000Z');
    assert.strictEqual(A.fromLocalInput('nope'), null);
  },

  async 'submit() with the fetch driver posts the form with the new values'({ D0007, assert, fetchLog }) {
    const A = D0007.Approvals;
    fetchLog.length = 0;
    const res = await A.submit(SHIFT, { start: new Date('2026-07-26T16:00:00Z'), end: new Date('2026-07-26T20:30:00Z'), hours: 4.5, status: A.STATUS.APPROVED }, { driver: 'fetch' });
    same(assert, res, { ok: true });
    const gi = fetchLog.findIndex(l => l.method === 'GET' && l.url.includes('/_portal/modal-form-template-path/'));
    const pi = fetchLog.findIndex(l => l.method === 'POST');
    assert.ok(gi >= 0 && pi > gi, 'GET the form, then POST it');
    const post = fetchLog[pi];
    assert.ok(post.url.includes('/_portal/modal-form-template-path/00000000-0000-0000-0000-000000000000?id=' + SHIFT));
    assert.ok(post.url.includes('entityformid=44862ec7-48ad-ec11-983e-000d3a0a0f70'));
    assert.strictEqual(post.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const body = new URLSearchParams(post.body);
    assert.strictEqual(body.get(P + 'sjavms_start'), '2026-07-26T16:00:00.0000000Z');
    assert.strictEqual(body.get(P + 'sjavms_end'), '2026-07-26T20:30:00.0000000Z');
    assert.strictEqual(body.get(P + 'sjavms_hours'), '4.50');
    assert.strictEqual(body.get(P + 'msnfp_schedulestatus'), '335940001');
    assert.strictEqual(body.get('__EVENTTARGET'), 'ctl00$ContentContainer$MainContent$EntityFormControl$UpdateButton');
    assert.strictEqual(body.get('__EVENTARGUMENT'), '');
    assert.strictEqual(body.get('__VIEWSTATE'), '__VIEWSTATE_PLACEHOLDER');
    assert.strictEqual(body.get('__EVENTVALIDATION'), '__EVENTVALIDATION_PLACEHOLDER');
    assert.strictEqual(body.get('__VIEWSTATEGENERATOR'), '32E59789');
    assert.strictEqual(body.get(P + 'frm_pref_7c09eaed'), '', 'honeypot sent empty');
    assert.strictEqual(body.get(P + 'msnfp_participationid'), '5bad352a-4685-f111-ab0e-7ced8da56148', 'untouched hidden fields go back as they came');
    assert.ok(!body.has('ctl00$ContentContainer$MainContent$EntityFormControl$UpdateButton'), 'the button itself is not a field');
  },

  async 'submit() refuses bad values before touching the network'({ D0007, assert, fetchLog }) {
    const A = D0007.Approvals;
    fetchLog.length = 0;
    await assert.rejects(A.submit(SHIFT, { start: new Date('2026-07-26T16:00:00Z'), end: new Date('2026-07-26T21:00:00Z'), hours: 0, status: A.STATUS.APPROVED }, { driver: 'fetch' }), /zero hours/);
    await assert.rejects(A.submit(SHIFT, { start: new Date('2026-07-26T16:00:00Z'), end: new Date('2026-07-26T21:00:00Z'), hours: 5, status: '9' }, { driver: 'fetch' }), /not a shift status/);
    assert.strictEqual(fetchLog.length, 0);
  },

  async 'submit() rejects with the server validation message'({ D0007, assert, mock }) {
    const A = D0007.Approvals;
    mock.override(isPost, (u, o, res) => res(html('<div class="validation-summary alert alert-danger"><ul><li>Hours cannot be blank</li></ul></div>')));
    await assert.rejects(A.submit(SHIFT, { start: new Date('2026-07-26T16:00:00Z'), end: new Date('2026-07-26T21:00:00Z'), hours: 5, status: A.STATUS.APPROVED }, { driver: 'fetch' }), /^Error: Hours cannot be blank$/);
    mock.clear();
    mock.override(isPost, (u, o, res) => res(html('<p>nothing useful</p>')));
    await assert.rejects(A.submit(SHIFT, { start: new Date('2026-07-26T16:00:00Z'), end: new Date('2026-07-26T21:00:00Z'), hours: 5, status: A.STATUS.APPROVED }, { driver: 'fetch' }), /did not confirm/);
    mock.clear();
  },

  async 'submit() stops if the form is not the one expected'({ D0007, assert, mock, fetchLog, fx }) {
    const A = D0007.Approvals;
    const values = { start: new Date('2026-07-26T16:00:00Z'), end: new Date('2026-07-26T21:00:00Z'), hours: 5, status: A.STATUS.APPROVED };
    mock.override(isFormGet, (u, o, res) => res(html(fx('approveShiftForm.html').replace(/id="sjavms_hours"/, 'id="sjavms_hrs"'))));
    await assert.rejects(A.submit(SHIFT, values, { driver: 'fetch' }), /no #sjavms_hours field/);
    assert.ok(!fetchLog.some(l => l.method === 'POST'), 'nothing posted');
    mock.clear();
    mock.override(isFormGet, (u, o, res) => res(html(fx('approveShiftForm.html').replace(/<option value="335940001">[^<]*<\/option>/, ''))));
    await assert.rejects(A.submit(SHIFT, values, { driver: 'fetch' }), /not an option on this form/);
    assert.ok(!fetchLog.some(l => l.method === 'POST'), 'nothing posted');
    mock.clear();
  },

  async 'run() continues past a failure, reports both, clears the caches'({ D0007, assert, mock, fx, fetchLog }) {
    const A = D0007.Approvals;
    const ids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333'];
    // serve the form fixture for whichever id was asked for, and fail the second post
    mock.override(isFormGet, (u, o, res) => res(html(fx('approveShiftForm.html').replace(/5aad352a-4685-f111-ab0e-7ced8da56148/g, new URL(u, 'https://x').searchParams.get('id')))));
    let n = 0;
    mock.override(isPost, (u, o, res) => (++n === 2 ? res(html('<div class="validation-summary"><ul><li>Shift Start is a required field.</li></ul></div>')) : res(html('<span id="MessageLabel">Submission completed successfully.</span>'))));
    const values = { start: new Date('2026-07-26T16:00:00Z'), end: new Date('2026-07-26T21:00:00Z'), hours: 5, status: A.STATUS.APPROVED };
    const items = ids.map(shiftId => ({ shiftId, values, tag: shiftId.slice(0, 1) }));
    await D0007.VMS.hours('');
    fetchLog.length = 0;
    const progress = [];
    const r = await A.run(items, { driver: 'fetch', onProgress: (i, res) => progress.push([i, res.ok]) });
    same(assert, progress, [[0, true], [1, false], [2, true]]);
    same(assert, r.done.map(d => d.shiftId), [ids[0], ids[2]]);
    assert.strictEqual(r.done[0].tag, '1', 'extra item fields come back');
    assert.strictEqual(r.failed.length, 1);
    assert.strictEqual(r.failed[0].shiftId, ids[1]);
    assert.match(r.failed[0].error, /Shift Start is a required field/);
    assert.strictEqual(fetchLog.filter(l => l.method === 'POST').length, 3);
    // caches were cleared: the hours feed is fetched again
    await D0007.VMS.hours('');
    assert.ok(fetchLog.some(l => l.url.includes('participation-reports-csv-feed')));
    // and with stopOnError it stops at the failure
    n = 0; progress.length = 0;
    const r2 = await A.run(items, { driver: 'fetch', stopOnError: true, onProgress: (i, res) => progress.push([i, res.ok]) });
    same(assert, progress, [[0, true], [1, false]]);
    assert.strictEqual(r2.done.length, 1); assert.strictEqual(r2.failed.length, 1);
    mock.clear();
  },

  async 'iframe driver gives up and cleans up'({ D0007, assert, document }) {
    // jsdom won't load the iframe, so this only proves the timeout path and
    // that the iframe doesn't get left behind.
    const A = D0007.Approvals;
    await assert.rejects(A.drivers.iframe(SHIFT, { sjavms_start: '2026-07-26T16:00:00.0000000Z', sjavms_end: '2026-07-26T21:00:00.0000000Z', sjavms_hours: '5.00', msnfp_schedulestatus: '335940001' }, { timeout: 60 }));
    assert.strictEqual(document.querySelectorAll('iframe').length, 0);
  },

  async 'hours tab shows the queue, loads a form on tick, and confirms before writing'({ D0007, document, window, assert, fetchLog }) {
    D0007.state.tab = 'hours';
    D0007.open();
    await wait(400);
    const root = document.querySelector('#d0007-root');
    const rows = root.querySelectorAll('tr.ap-row');
    assert.strictEqual(rows.length, 3, 'three pending rows');
    assert.strictEqual(root.querySelectorAll('.ap-group').length, 3, 'grouped by event');
    assert.ok(/Oakville/.test(root.querySelector('.ap-group .ap-gtitle b').textContent), 'most recent event first');
    assert.ok(root.querySelector('#ap-submit').disabled, 'nothing selected yet');
    assert.ok(!root.querySelector('.ap-report table'), 'hours report collapsed by default');
    // tick the first row (the one the form fixture is for)
    const first = rows[0];
    assert.strictEqual(first.dataset.id, SHIFT);
    fetchLog.length = 0;
    const cb = first.querySelector('[data-sel]'); cb.checked = true; cb.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(200);
    assert.ok(fetchLog.some(l => l.url.includes('/_portal/modal-form-template-path/') && l.url.includes(SHIFT)), 'form loaded lazily');
    assert.ok(/Sunday - Shift A/.test(first.querySelector('.ap-sub').textContent), 'row shows the schedule from the form');
    assert.ok(/Submit 1 change/.test(root.querySelector('#ap-submit').textContent));
    // change the hours: end follows (12:00 p.m. Eastern start)
    assert.ok(/5:00 p\.m\./.test(first.querySelector('.ap-end').textContent), 'end from the form: ' + first.querySelector('.ap-end').textContent);
    const hrs = first.querySelector('[data-hours]'); hrs.value = '4'; hrs.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.ok(/4:00 p\.m\./.test(first.querySelector('.ap-end').textContent), 'end recomputed from hours: ' + first.querySelector('.ap-end').textContent);
    assert.strictEqual(first.nextElementSibling.querySelector('[data-end]').value, '2026-07-26T16:00', 'time editor follows too');
    // submit -> confirmation panel, nothing posted yet
    root.querySelector('#ap-submit').click();
    await wait(200);
    const panel = root.querySelector('.ap-confirm');
    assert.ok(panel, 'confirmation panel shown');
    assert.ok(/Test Volunteer 91 — Oakville latino festival — 4\.00 h \(Sun, Jul 26, 12:00 p\.m\. – 4:00 p\.m\.\) → Shift Hours Approved/.test(panel.textContent), panel.textContent);
    assert.ok(/can.t be put back to pending/.test(panel.textContent));
    assert.ok(!fetchLog.some(l => l.method === 'POST'), 'nothing written before Confirm');
    root.querySelector('#ap-cancel').click();
    await wait(50);
    assert.ok(!root.querySelector('.ap-confirm'), 'cancel closes the panel');
    assert.ok(!fetchLog.some(l => l.method === 'POST'));
    // the hours report is still there, behind its toggle
    root.querySelector('#ap-report-tog').click();
    await wait(200);
    assert.ok(root.querySelector('.ap-report table'), 'hours report opens');
  },

  async 'confirm runs the writes, drops the done row, keeps the failed one with its message'({ D0007, document, window, assert, mock, fx, fetchLog }) {
    const A = D0007.Approvals;
    A.defaultDriver = 'fetch';
    // the form fixture for whichever shift is asked for; the Beer shift's post fails
    mock.override(isFormGet, (u, o, res) => res(html(fx('approveShiftForm.html').replace(/5aad352a-4685-f111-ab0e-7ced8da56148/g, new URL(u, 'https://x').searchParams.get('id')))));
    mock.override(isPost, (u, o, res) => (u.includes('038ce913') ? res(html('<div class="validation-summary"><ul><li>Hours must be between 0 and 24.</li></ul></div>')) : res(html('<span id="MessageLabel">Submission completed successfully.</span>'))));
    try {
      D0007.state.tab = 'hours'; D0007.state.pendingSearch = '';
      D0007.render();
      await wait(400);
      const root = document.querySelector('#d0007-root');
      assert.strictEqual(root.querySelectorAll('tr.ap-row').length, 3);
      // "Approve all as reported" on the first group (Oakville), plus tick the Beer row
      root.querySelector('[data-approveall="0"]').click();
      await wait(50);
      const beer = [...root.querySelectorAll('tr.ap-row')].find(tr => tr.dataset.id.startsWith('038ce913'));
      const cb = beer.querySelector('[data-sel]'); cb.checked = true; cb.dispatchEvent(new window.Event('change', { bubbles: true }));
      await wait(300);
      assert.ok(/Submit 2 changes/.test(root.querySelector('#ap-submit').textContent));
      root.querySelector('#ap-submit').click();
      await wait(300);
      assert.strictEqual(root.querySelectorAll('.ap-confirm ul.plain li').length, 2);
      fetchLog.length = 0;
      root.querySelector('#ap-confirm').click();
      await wait(600);
      assert.strictEqual(fetchLog.filter(l => l.method === 'POST').length, 2, 'two posts, one per shift');
      assert.ok(!root.querySelector('.ap-confirm'), 'panel gone');
      const last = root.querySelector('.ap-last');
      assert.ok(last && /1 updated, 1 failed/.test(last.textContent), last && last.textContent);
      assert.ok(/Hours must be between 0 and 24/.test(last.textContent));
      // queue reloaded: the fixture still serves all three, so the "done" one comes back from VMS
      // (that is the honest result of a reload against a static fixture); the failed row keeps its message
      const beerAgain = [...root.querySelectorAll('tr.ap-row')].find(tr => tr.dataset.id.startsWith('038ce913'));
      assert.ok(beerAgain && /Hours must be between 0 and 24/.test(beerAgain.querySelector('.ap-msg').textContent), 'failure shown on the row');
      assert.ok(beerAgain.querySelector('[data-sel]').checked, 'failed row stays selected for a retry');
      assert.ok(fetchLog.some(l => l.url.includes('/en-US/group-lead/hours/')), 'pending list re-read after the run');
    } finally { A.defaultDriver = 'iframe'; mock.clear(); }
  },

  async 'pending rows on an event hand off to the hours tab filtered to that event'({ D0007, document, assert }) {
    D0007.state.tab = 'events'; D0007.state.pendingSearch = '';
    D0007.render();
    await wait(300);
    const root = document.querySelector('#d0007-root');
    const card = root.querySelector('.card');
    const title = card.querySelector('h3').textContent;
    card.querySelector('[data-open]').click();
    await wait(300);
    const btns = root.querySelectorAll('.detail [data-approve]');
    assert.strictEqual(btns.length, 2, 'one button per pending shift, none for the cancelled one');
    assert.strictEqual(btns[0].dataset.approve, title);
    btns[0].click();
    await wait(400);
    assert.strictEqual(D0007.state.tab, 'hours');
    assert.strictEqual(root.querySelector('#ap-q').value, title, 'search prefilled with the event');
    assert.ok(root.querySelector('#ap-groups .card.muted'), 'fixture queue has no shifts for that event, so the filter shows none');
    root.querySelector('#ap-q').value = 'Beer'; root.querySelector('#ap-q').dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
    assert.strictEqual(root.querySelectorAll('tr.ap-row').length, 1, 'typing filters without a reload');
  },
};
