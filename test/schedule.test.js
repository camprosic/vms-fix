// Schedule module and screen. The stock fixture serves the same three shifts
// for every event, so these tests teach the mock a per-event event-summary
// page (grid config "p:<eventid>" / "s:<eventid>") and answer the subgrid
// calls for those from PORTAL below. Everything else falls through to the
// fixtures.
const assert = require('assert');

// Fixture event ids (test/fixtures/subgridEvents.json)
const TICATS = '6c78a154-5e24-f111-8342-7c1e525316e3';   // Sat Oct 24 2026 12:00
const R2H = 'e315b994-2eb8-f111-aaad-7ced8de00f7d';      // Sat Oct 31 2026 07:30
const FULL = 'b8147349-adb9-f111-aaad-6045bd5e69ae';     // Sun Nov 1 2026 06:15

// Eastern: Oct 24 is EDT (-4), Nov 1 is EST (-5) after the 02:00 change.
const PORTAL = {
  [TICATS]: {
    participants: [['Alice Able', 'Approved'], ['Bob Baker', 'Approved'], ['Cara Cole', 'Approved'], ['Fred Fox', 'Approved'], ['Gus Gone', 'Cancelled']],
    shifts: [
      ['Alice Able', '2026-10-24T16:00:00Z', 7, 'Pending'],
      ['Bob Baker', '2026-10-24T16:00:00Z', 7, 'Shift Hours Approved'],
      ['Cara Cole', '2026-10-24T20:30:00Z', 2.5, 'Pending'],          // 16:30 to end: partial
      ['Dan Drop', '2026-10-24T16:00:00Z', 7, 'Cancelled'],
      ['Eve Early', '2026-10-24T16:00:00Z', 7, 'Waitlist'],
    ],
  },
  [R2H]: {   // two days
    participants: [['Alice Able', 'Approved'], ['Hal Hill', 'Approved']],
    shifts: [
      ['Alice Able', '2026-10-31T11:30:00Z', 5, 'Pending'],
      ['Hal Hill', '2026-10-31T11:30:00Z', 5, 'Pending'],
      ['Hal Hill', '2026-11-01T11:15:00Z', 6, 'Pending'],
    ],
  },
  [FULL]: { participants: [['Ivy Idle', 'Approved']], shifts: [] },   // nothing scheduled yet
};
const CERTS = '"Qualified Contact","Qualification","Effective Date","Expiration Date"\n'
  + '"Alice Able","Medical First Responder","2025/01/01","2099/01/01"\n'
  + '"Bob Baker","Medical First Responder","2020/01/01","2021/01/01"\n'   // lapsed
  + '"Cara Cole","Emergency First Aid","2025/01/01","2099/01/01"\n';

function grid(rel, cfg) {
  const layout = [{ Base64SecureConfiguration: cfg, SortExpression: '', Columns: [] }];
  return `<table><tr><td><div class="entity-grid" data-ref-rel="${rel}" data-ref-id="x" data-get-url="/_services/entity-subgrid-data.json/test" data-view-layouts="${Buffer.from(JSON.stringify(layout)).toString('base64')}"></div></td></tr></table>`;
}
const attr = (Name, Type, Value, DisplayValue) => ({ Name, Type, Value, DisplayValue, FormattedValue: DisplayValue });
const ref = name => ({ Name: name, Id: 'c-' + name.toLowerCase().replace(/\W+/g, '-') });
const dt = iso => attr(null, 'System.DateTime', `/Date(${Date.parse(iso)})/`, iso);
const rec = (id, attrs) => ({ Id: id, StateCode: 0, StatusCode: 1, Attributes: attrs });
function records(cfg) {
  const [kind, id] = cfg.split(':'); const ev = PORTAL[id]; if (!ev) return null;
  if (kind === 'p') return ev.participants.map(([name, status], i) => rec(`p-${id}-${i}`, [attr('msnfp_contactid', 'Microsoft.Xrm.Sdk.EntityReference', ref(name), name), attr('msnfp_status', 'Microsoft.Xrm.Sdk.OptionSetValue', { Value: 1 }, status), { ...dt('2026-10-01T12:00:00Z'), Name: 'createdon' }, attr('msnfp_hours', 'System.Decimal', 0, '0.00'), attr('sjavms_totalpendinghours', 'System.Decimal', 0, '0.00')]));
  if (kind === 's') return ev.shifts.map(([name, start, hours, status], i) => rec(`s-${id}-${i}`, [attr('sjavms_volunteer', 'Microsoft.Xrm.Sdk.EntityReference', ref(name), name), { ...dt(start), Name: 'sjavms_start' }, attr('sjavms_hours', 'System.Decimal', hours, String(hours)), attr('msnfp_schedulestatus', 'Microsoft.Xrm.Sdk.OptionSetValue', { Value: 1 }, status)]));
  return null;
}
let installed = false;
function installPortal({ mock }) {
  if (installed) return; installed = true;
  mock.override(u => u.includes('/en-US/group-lead/event-summary/') && /eventid=([0-9a-f-]{36})/.test(u) && !!PORTAL[/eventid=([0-9a-f-]{36})/.exec(u)[1]], (u, o, res) => {
    const id = /eventid=([0-9a-f-]{36})/.exec(u)[1];
    return res(`<!doctype html><html><body>${grid('msnfp_msnfp_engagementopportunity_msnfp_participation_engagementOpportunityId', 'p:' + id)}${grid('sjavms_msnfp_engagementopportunity_msnfp_participationschedule_VolunteerEvent', 's:' + id)}<input id="msnfp_shortdescription" value="d"></body></html>`);
  });
  mock.override((u, o) => u.includes('/_services/entity-subgrid-data.json/') && !!records(JSON.parse(o.body).base64SecureConfiguration), (u, o, res) => {
    const body = JSON.parse(o.body);
    return res(JSON.stringify({ Records: body.page > 1 ? [] : records(body.base64SecureConfiguration), MoreRecords: false, ItemCount: 0 }), 'application/json');
  });
  mock.override(u => u.includes('qualifications-gained-csv-feed') && u.includes('next90days'), (u, o, res) => res(CERTS, 'text/csv'));
}
// Quote-aware TSV reader, enough to check what Excel would see.
function parseTSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"' && f === '') q = true;
    else if (c === '\t') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const byName = (list, n) => list.find(p => p.name === n);
// Objects from the script live in jsdom's realm, so deepStrictEqual trips on
// prototypes. Compare the JSON instead.
const eq = (a, b, msg) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), msg);

module.exports = {
  async 'rows come out per event and per day'(t) {
    installPortal(t);
    const S = t.D0007.Schedule;
    const oct = await S.monthRows(2026, 10);
    eq(oct.map(r => r.key), [`${TICATS}|2026-10-24`, `${R2H}|2026-10-31`], 'October: one row per (event, day), in date order');
    assert.strictEqual(oct[0].dateLabel, 'Sat Oct 24');
    assert.strictEqual(oct[0].title, 'Ti-Cats vs Ottawa Redblacks');
    assert.strictEqual(oct[0].location, 'Hamilton Stadium');
    const nov = await S.monthRows(2026, 11);
    eq(nov.map(r => r.key).sort(), [`${FULL}|2026-11-01`, `${R2H}|2026-11-01`].sort(), 'November: day two of the two-day event, and the event with no shifts on its start date');
    const full = nov.find(r => r.eventId === FULL);
    assert.strictEqual(full.people.length, 0); assert.strictEqual(full.meetEvent, ''); assert.strictEqual(full.shiftCount, 0);
    eq(full.signedUpNoShift.map(p => p.name), ['Ivy Idle']);
    assert.strictEqual(new Set(oct.concat(nov).map(r => r.key)).size, 4, 'keys are unique');
  },
  async 'meet and end come from the main shift; a shorter shift is partial'(t) {
    installPortal(t);
    const [row] = await t.D0007.Schedule.monthRows(2026, 10);
    assert.strictEqual(row.meetEvent, '12:00');
    assert.strictEqual(row.approxEnd, '19:00');
    eq(row.derived, { meetEvent: '12:00', approxEnd: '19:00', notes: ['**16:30 to End'] });
    eq(row.people.map(p => p.name).sort(), ['Alice Able', 'Bob Baker', 'Cara Cole'], 'cancelled and waitlisted shifts are not on the row');
    assert.strictEqual(byName(row.people, 'Alice Able').partial, null);
    eq(byName(row.people, 'Cara Cole').partial, { start: '16:30', end: '19:00', marker: '**', mark: '*' });
    eq(row.waitlisted.map(p => p.name), ['Eve Early']);
    eq(row.signedUpNoShift.map(p => p.name), ['Fred Fox'], 'signed up with no shift, cancelled sign-up ignored');
    assert.ok(/Alice Able\n|Alice Able$/.test(row.people.map(p => p.name).join('\n')));
  },
  async 'deriveDay: ties go to the earliest start, distinct partial windows get ** then ***'(t) {
    const S = t.D0007.Schedule;
    const sh = (name, start, hours, status = 'Pending') => ({ name, start, hours, status });
    const d = S.deriveDay([
      sh('P1', '2026-10-24T16:00:00Z', 7), sh('P2', '2026-10-24T16:00:00Z', 7),
      sh('Q1', '2026-10-24T17:00:00Z', 6), sh('Q2', '2026-10-24T17:00:00Z', 6),   // same count as 12:00, later -> loses the tie
      sh('X', '2026-10-24T20:30:00Z', 2.5), sh('Y', '2026-10-24T20:30:00Z', 2.5),  // same window as X -> same marker
      sh('Z', '2026-10-24T16:00:00Z', 3),                                         // leaves early
      sh('N', '2026-10-24T16:00:00Z', 7, 'No Show'),
    ]);
    assert.strictEqual(d.meetEvent, '12:00'); assert.strictEqual(d.approxEnd, '19:00');
    // markers are handed out in start-time order, one per distinct window
    eq(d.notes, ['**12:00 to 15:00', '***13:00 to End', '****16:30 to End']);
    eq(byName(d.people, 'Z').partial, { start: '12:00', end: '15:00', marker: '**', mark: '*' });
    assert.strictEqual(byName(d.people, 'Q1').partial.marker, '***');
    assert.strictEqual(byName(d.people, 'Q2').partial.marker, '***');
    assert.strictEqual(byName(d.people, 'X').partial.marker, '****');
    assert.strictEqual(byName(d.people, 'Y').partial.mark, '***');
    assert.strictEqual(byName(d.people, 'P1').partial, null);
    assert.strictEqual(byName(d.people, 'N').status, 'No Show', 'no-shows stay on the row (they were scheduled)');
    assert.strictEqual(S.deriveDay([sh('A', '2026-10-24T16:00:00Z', 7, 'No Show')]).meetEvent, '12:00', 'a day with only no-shows still has a window');
    eq(S.deriveDay([]).people, []);
    assert.strictEqual(S.deriveDay([]).meetEvent, '');
  },
  async 'store overrides win and the VMS value stays visible'(t) {
    installPortal(t);
    t.D0007.Store.reset();
    const { Schedule: S, Store } = t.D0007;
    const key = `${TICATS}|2026-10-24`;
    Store.set('schedule', key, { meetSJ: '11:00', meetEvent: '11:30', coordinator: 'Jane Doe', requirement: '1 Command / 1 Driver / 3 MFR', notes: 'Food provided', equipment: 'HWP 43\nHWP 44', vehicle: '1037', colour: '#ffff00' });
    let [row] = await S.monthRows(2026, 10);
    assert.strictEqual(row.meetEvent, '11:30'); assert.strictEqual(row.derived.meetEvent, '12:00'); assert.strictEqual(row.edited.meetEvent, true);
    assert.strictEqual(row.approxEnd, '19:00'); assert.strictEqual(row.edited.approxEnd, false);
    assert.strictEqual(row.meetSJ, '11:00'); assert.strictEqual(row.coordinator, 'Jane Doe'); assert.strictEqual(row.colour, '#FFFF00', 'colour normalised to the sheet hex');
    assert.strictEqual(S.eventNotes(row), '1 Command / 1 Driver / 3 MFR\n**16:30 to End\nFood provided');
    Store.patch('schedule', key, { meetEvent: '', colour: '#123456' });
    row = S.withOverrides(row);
    assert.strictEqual(row.meetEvent, '12:00', 'empty override falls back to VMS'); assert.strictEqual(row.edited.meetEvent, false);
    assert.strictEqual(row.colour, '', 'unknown colour ignored');
    Store.set('schedule', key, undefined);
  },
  async 'role comes from a current MFR cert unless set on the roster'(t) {
    installPortal(t);
    t.D0007.Store.reset();
    const { Schedule: S, Store } = t.D0007;
    const certs = await t.D0007.VMS.certifications();
    assert.strictEqual(S.memberInfo('Alice Able', { certs }).role, 'MFR');
    assert.strictEqual(S.memberInfo('alice  ABLE', { certs }).role, 'MFR', 'name match is normalised');
    assert.strictEqual(S.memberInfo('Bob Baker', { certs }).role, 'Apprentice', 'lapsed cert does not count');
    assert.strictEqual(S.memberInfo('Cara Cole', { certs }).role, 'Apprentice', 'other certs do not count');
    assert.strictEqual(S.memberInfo('Nobody', { certs }).role, 'Apprentice');
    Store.patch('members', 'bob baker', { role: 'MFR', tags: ['Sr', 'C', 'bogus'], unit: ' Burl ' });
    Store.patch('members', 'alice able', { role: 'Apprentice' });
    const bob = S.memberInfo('Bob Baker', { certs, members: Store.all('members') });
    eq({ role: bob.role, autoRole: bob.autoRole, roleSet: bob.roleSet, tags: bob.tags, unit: bob.unit }, { role: 'MFR', autoRole: 'Apprentice', roleSet: true, tags: ['C', 'Sr'], unit: 'Burl' });
    const [row] = await S.monthRows(2026, 10);
    assert.strictEqual(byName(row.people, 'Alice Able').role, 'Apprentice', 'roster override beats the cert');
    assert.strictEqual(byName(row.people, 'Bob Baker').role, 'MFR');
    assert.strictEqual(row.people[0].name, 'Bob Baker', 'Command sorts first');
    assert.strictEqual(byName(row.signedUpNoShift, 'Fred Fox').role, 'Apprentice');
    Store.set('members', 'bob baker', undefined); Store.set('members', 'alice able', undefined);
  },
  async 'toTSV: twelve columns, header first, multi-line cells quoted'(t) {
    installPortal(t);
    t.D0007.Store.reset();
    const { Schedule: S, Store } = t.D0007;
    Store.set('schedule', `${TICATS}|2026-10-24`, { requirement: '1 Command / 1 Driver / 3 MFR', notes: 'Food "provided"', equipment: 'HWP 43\nHWP 44', vehicle: '1154 / 3006' });
    Store.patch('members', 'alice able', { tags: ['C', 'D'] });
    const rows = await S.monthRows(2026, 10);
    const tsv = S.toTSV(rows);
    const lines = tsv.split('\n');
    assert.strictEqual(lines[0], S.COLUMNS.join('\t'), 'header row first, tab separated');
    assert.strictEqual(S.COLUMNS.length, 12);
    const parsed = parseTSV(tsv);
    assert.strictEqual(parsed.length, 1 + 3, 'header, two rows, one spacer between the two dates');
    parsed.forEach((r, i) => assert.strictEqual(r.length, 12, `row ${i} has 12 cells`));
    const ti = parsed[1];
    eq(ti.slice(0, 7), ['Ti-Cats vs Ottawa Redblacks', 'Sat Oct 24', '', '12:00', '19:00', 'Hamilton Stadium', '']);
    assert.strictEqual(ti[7], '1 Command / 1 Driver / 3 MFR\n**16:30 to End\nFood "provided"');
    assert.strictEqual(ti[8], 'Alice Able C/D');
    assert.strictEqual(ti[9], 'Bob Baker\nCara Cole*');
    assert.strictEqual(ti[10], 'HWP 43\nHWP 44'); assert.strictEqual(ti[11], '1154 / 3006');
    assert.ok(parsed[2].every(c => c === ''), 'spacer row is blank');
    assert.strictEqual(parsed[3][0], 'Hamilton Marathon Road2Hope 5/10KM');
    assert.ok(tsv.includes('"HWP 43\nHWP 44"'), 'multi-line cell is quoted');
    assert.ok(tsv.includes('Food ""provided""'), 'embedded quotes doubled');
    const wb = S.toWorkbookRows(rows);
    assert.strictEqual(wb.rows.length, wb.colours.length); eq(wb.rows[0], S.COLUMNS); eq(wb.rows[1], ti);
    Store.set('schedule', `${TICATS}|2026-10-24`, undefined); Store.set('members', 'alice able', undefined);
  },
  async 'names are formatted like the sheet'(t) {
    const f = t.D0007.Schedule.formatName;
    assert.strictEqual(f({ name: 'Jane Doe', tags: [], unit: '', partial: null }), 'Jane Doe');
    assert.strictEqual(f({ name: 'Jane Doe', tags: ['C'], unit: '', partial: null }), 'Jane Doe C');
    assert.strictEqual(f({ name: 'Jane Doe', tags: ['C', 'D', 'Sr'], unit: '', partial: null }), 'Jane Doe C/D/Sr');
    assert.strictEqual(f({ name: 'Jane Doe', tags: [], unit: 'Burl', partial: null }), 'Jane Doe (Burl)');
    assert.strictEqual(f({ name: 'Jane Doe', tags: ['D'], unit: 'Halton Hills', partial: { start: '16:30', end: '19:00', marker: '**', mark: '*' } }), 'Jane Doe D (Halton Hills)*');
    assert.strictEqual(f({ name: 'Jane Doe', tags: [], unit: '', partial: { start: '17:00', end: '19:00', marker: '***', mark: '**' } }), 'Jane Doe**');
  },
  async 'xlsx carries the sheet name and the row fills'(t) {
    installPortal(t);
    t.D0007.Store.reset();
    const { Schedule: S, Store } = t.D0007;
    Store.set('schedule', `${TICATS}|2026-10-24`, { colour: '#FF9900' });
    const rows = await S.monthRows(2026, 10);
    const bytes = S.toXLSX(rows, { sheetName: 'October' });
    const s = Buffer.from(bytes).toString('latin1');
    assert.strictEqual(s.slice(0, 4), 'PK\x03\x04', 'zip header');
    assert.ok(s.includes('xl/worksheets/sheet1.xml') && s.includes('xl/styles.xml') && s.includes('[Content_Types].xml'));
    assert.ok(s.includes('<sheet name="October" sheetId="1"'));
    assert.ok(s.includes('<fgColor rgb="FFFF9900"/>'), 'fill defined');
    const orange = 2 + S.COLOURS.findIndex(c => c.hex === '#FF9900');
    assert.ok(s.includes(`<c r="A2" s="${orange}" t="inlineStr"><is><t xml:space="preserve">Ti-Cats vs Ottawa Redblacks</t></is></c>`), 'first data row uses the orange style');
    assert.ok(s.includes(`<c r="G2" s="${orange}"/>`), 'empty cells on a coloured row still get the fill');
    assert.ok(s.includes('<c r="A4" s="0" t="inlineStr">'), 'uncoloured row uses the plain style');
    assert.ok(s.includes('orientation="landscape"') && s.includes('state="frozen"'));
    Store.set('schedule', `${TICATS}|2026-10-24`, undefined);
  },
  async 'schedule tab renders and cells edit inline'(t) {
    installPortal(t);
    t.D0007.Store.reset();
    const { D0007, document, window: w } = t;
    D0007.state.schedY = 2026; D0007.state.schedM = 10;
    D0007.state.tab = 'schedule'; D0007.open();   // first open renders the current tab
    await wait(400);
    const trs = document.querySelectorAll('#d0007-root tr[data-key]');
    assert.strictEqual(trs.length, 2, 'two event-day rows');
    assert.ok(document.querySelector('#d0007-root tr.sched-gap'), 'spacer between dates');
    assert.strictEqual(document.querySelectorAll('#d0007-root .sched-table thead th').length, 12);
    assert.ok(document.querySelector('#d0007-root .sched-h').textContent.includes('October 2026'));
    const first = trs[0];
    assert.ok(first.querySelector('a[href*="event-summary"][href*="eventid=' + TICATS + '"]'), 'Open in VMS link');
    assert.ok(first.textContent.includes('Cara Cole*') || first.querySelector('.star'), 'partial marker shown');
    assert.ok(first.textContent.includes('(signed up, no shift)'));
    // click-to-edit, Enter saves
    first.querySelector('.ed[data-field="coordinator"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    let inp = first.querySelector('.ed[data-field="coordinator"] input'); assert.ok(inp, 'input appears');
    inp.value = 'Jane Doe'; inp.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.strictEqual(D0007.Store.get('schedule', `${TICATS}|2026-10-24`).coordinator, 'Jane Doe');
    assert.ok(first.querySelector('.ed[data-field="coordinator"]').textContent.includes('Jane Doe'));
    // Esc cancels
    first.querySelector('.ed[data-field="meetSJ"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    inp = first.querySelector('.ed[data-field="meetSJ"] input'); inp.value = '09:00'; inp.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.strictEqual(D0007.Store.get('schedule', `${TICATS}|2026-10-24`).meetSJ, undefined);
    assert.ok(!first.querySelector('input'), 'edit box gone');
    // override of a VMS value shows the marker; blur saves a textarea
    first.querySelector('.ed[data-field="meetEvent"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    inp = first.querySelector('.ed[data-field="meetEvent"] input'); inp.value = '11:30'; inp.dispatchEvent(new w.Event('blur'));
    assert.ok(first.querySelector('.ed[data-field="meetEvent"] .edited'), 'edited marker');
    first.querySelector('.ed[data-field="equipment"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    const ta = first.querySelector('.ed[data-field="equipment"] textarea'); assert.ok(ta); ta.value = 'HWP 43\nHWP 44'; ta.dispatchEvent(new w.Event('blur'));
    assert.strictEqual(D0007.Store.get('schedule', `${TICATS}|2026-10-24`).equipment, 'HWP 43\nHWP 44');
    // colour swatch
    first.querySelector('.sw[data-colour="#00FF00"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(D0007.Store.get('schedule', `${TICATS}|2026-10-24`).colour, '#00FF00');
    assert.ok(first.querySelector('.sw.on[data-colour="#00FF00"]'));
    // month nav
    document.querySelector('#d0007-root [data-nav="1"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait(400);
    assert.strictEqual(D0007.state.schedM, 11);
    assert.strictEqual(document.querySelectorAll('#d0007-root tr[data-key]').length, 2, 'November rows');
    assert.ok(document.querySelector('#d0007-root .sched-h').textContent.includes('November 2026'));
    D0007.Store.set('schedule', `${TICATS}|2026-10-24`, undefined);
  },
  async 'roster shows the role and saves schedule tags'(t) {
    installPortal(t);
    t.D0007.Store.reset();
    const { D0007, document, window: w } = t;
    D0007.open(); D0007.state.tab = 'roster'; D0007.render();
    await wait(400);
    const ths = [...document.querySelectorAll('#d0007-root thead th')].map(h => h.textContent.trim());
    assert.ok(ths.includes('Role'));
    const tr = document.querySelector('#d0007-root tr[data-sel]'); assert.ok(tr);
    assert.ok(/MFR|Apprentice/.test(tr.children[1].textContent));
    tr.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait(400);
    const form = document.querySelector('#d0007-root #d7-tags'); assert.ok(form, 'schedule tags form in the side panel');
    form.querySelector('input[name=tag][value="C"]').checked = true;
    form.querySelector('select[name=role]').value = 'MFR';
    form.querySelector('input[name=unit]').value = 'Burl';
    form.querySelector('select[name=role]').dispatchEvent(new w.Event('change', { bubbles: true }));
    await wait(300);
    const name = document.querySelector('#d0007-root tr[data-sel]').children[0].textContent.trim();
    const saved = D0007.Store.get('members', name.toLowerCase());
    eq(saved, { role: 'MFR', tags: ['C'], unit: 'Burl' });
    assert.ok(document.querySelector('#d0007-root tr[data-sel]').children[1].textContent.includes('MFR'));
    assert.ok(document.querySelector('#d0007-root tr[data-sel]').children[1].textContent.includes('(Burl)'));
  },
  async 'data tab resets with an inline confirm'(t) {
    const { D0007, document, window: w } = t;
    D0007.Store.set('settings', 'x', 1);
    D0007.open(); D0007.state.tab = 'data'; D0007.render();
    await wait(200);
    assert.ok(document.querySelector('#d0007-root #d7-export'));
    assert.ok(!document.querySelector('#d0007-root #d7-reset-yes'));
    document.querySelector('#d0007-root #d7-reset').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    assert.ok(document.querySelector('#d0007-root #d7-reset-yes'), 'confirm appears inline');
    document.querySelector('#d0007-root #d7-reset-no').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(D0007.Store.get('settings', 'x'), 1, 'cancel keeps data');
    document.querySelector('#d0007-root #d7-reset').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    document.querySelector('#d0007-root #d7-reset-yes').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(D0007.Store.get('settings', 'x'), undefined, 'reset clears');
    assert.ok(document.querySelector('#d0007-root').textContent.includes('Local data cleared'));
  },
};
