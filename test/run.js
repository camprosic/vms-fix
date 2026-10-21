// Test runner. Loads the built userscript into jsdom with a fake VMS portal
// (fetch answered from test/fixtures) and runs every test/*.test.js.
//
//   npm test            builds first, then runs
//   node test/run.js    runs against the current build
//
// Each test file exports async function(t) and gets { D0007, window, document,
// assert, isDate, fetchLog, mock } where mock lets a test override a route.
// (Use isDate, not instanceof Date: the script's Dates come from jsdom's realm.)
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const FX = path.join(__dirname, 'fixtures');
const fx = f => fs.readFileSync(path.join(FX, f), 'utf8');
const GROUP_ID = 'cf450413-327a-ed11-81ad-0022486d6297';

// A fake Group Lead page: entity grids with the same data-* attributes the real
// ones carry. The secure config just names which fixture to serve.
function gridDiv(label, rel, cfg) {
  const layout = [{ Base64SecureConfiguration: cfg, SortExpression: '', Columns: [] }];
  return `<table><tr><td><label>${label}</label><div class="entity-grid" data-ref-rel="${rel}" data-ref-id="x" data-get-url="/_services/entity-subgrid-data.json/24684e99-f092-4556-8b54-060fd532e73b" data-view-layouts="${Buffer.from(JSON.stringify(layout)).toString('base64')}"></div></td></tr></table>`;
}
const page = body => `<!doctype html><html><head></head><body>${body}</body></html>`;

function eventsPage() {
  return page(['Current Events|current', 'Upcoming Events|events', 'Past Events|past', 'Ad Hoc Events|adhoc']
    .map(x => { const [l, c] = x.split('|'); return gridDiv(l, 'sjavms_msnfp_engagementopportunity_msnfp_group', c); }).join(''));
}
function eventSummaryPage() {
  return page(gridDiv('', 'msnfp_msnfp_engagementopportunity_msnfp_participation_engagementOpportunityId', 'participations')
    + gridDiv('', 'sjavms_msnfp_engagementopportunity_msnfp_participationschedule_VolunteerEvent', 'schedules')
    + '<input id="msnfp_shortdescription" value="Test event description">');
}
function hoursPage(url) {
  const pg = +(new URL(url, 'https://x').searchParams.get('fetchPage') || 1);
  const js = pg === 1 ? fx('hoursPage.js') : 'var totalRecordCount = 3;\n';
  return page(`<script>var portalId = "00000000-0000-0000-0000-000000000000";\nfunction getPendingShifts(){\n${js}\n}</script><table id="pendingShiftsTable"></table><ul id="pager"></ul>`);
}
const subgridFor = cfg => ({ events: 'subgridEvents.json', current: null, past: 'subgridEvents.json', adhoc: null, participations: 'subgridParticipations.json', schedules: 'subgridSchedules.json', requests: 'subgridRequests.json' })[cfg];

function makeMock() {
  const overrides = [];
  const log = [];
  const res = (body, type = 'text/html', status = 200, url = '') => ({
    ok: status >= 200 && status < 300, status, redirected: false, url,
    headers: { get: h => (h.toLowerCase() === 'content-type' ? type : null) },
    text: async () => body, json: async () => JSON.parse(body),
  });
  async function fetch(url, opts = {}) {
    const u = String(url); log.push({ url: u, method: (opts.method || 'GET').toUpperCase(), body: opts.body, headers: opts.headers });
    for (const o of overrides) if (o.test(u, opts)) return o.respond(u, opts, res);
    if (u.includes('/_layout/tokenhtml')) return res('<input name="__RequestVerificationToken" value="TESTTOKEN">');
    if (u.includes('/en-US/get-engagements/')) return res(fx('getEngagements.json'));
    if (u.includes('/_api/msnfp_publicengagementopportunities')) {
      const du = decodeURIComponent(u);
      const ids = [...du.matchAll(/eq ([0-9a-f-]{36})/g)].map(m => m[1]);
      const ev = JSON.parse(fx('subgridEvents.json')).Records[0].Id;
      if (du.includes('_msnfp_engagementopportunityid_value eq')) {
        // event id -> public id: every event gets a public id that is its own id with the first block flipped
        return res(JSON.stringify({ value: ids.map(id => ({ msnfp_publicengagementopportunityid: 'pub' + id.slice(3), _msnfp_engagementopportunityid_value: id })) }), 'application/json');
      }
      // public id -> event id (map every public id in the getEngagements fixture onto the first event id in the subgrid fixture)
      return res(JSON.stringify({ value: ids.map((id, i) => ({ msnfp_publicengagementopportunityid: id, _msnfp_engagementopportunityid_value: i === 0 ? ev : id })) }), 'application/json');
    }
    if (u.includes('/en-US/group-lead/events/')) return res(eventsPage());
    if (u.includes('/en-US/group-lead/dashboard/')) return res(page(gridDiv('Pending Approval', 'sjavms_msnfp_group_sjavms_eventrequest', 'requests')));
    if (u.includes('/en-US/group-lead/event-general/')) return res(page(fx('requestForm.html')));
    if (u.includes('/engagement/?id=')) return res(page(fx('publicEvent.html')));
    if (u.includes('/_api/msnfp_engagementopportunities?')) {
      const ids = [...decodeURIComponent(u).matchAll(/eq ([0-9a-f-]{36})/g)].map(m => m[1]);
      return res(JSON.stringify({ value: ids.map(id => ({ msnfp_engagementopportunityid: id, msnfp_street1: '64 Melrose Ave N', msnfp_city: 'Hamilton', msnfp_stateprovince: 'ON', msnfp_zippostalcode: 'L8L 8C1', msnfp_shortdescription: 'Tiger Cat CFL Game' })) }), 'application/json');
    }
    if (u.includes('/en-US/group-lead/event-summary/')) return res(eventSummaryPage());
    if (u.includes('/en-US/group-lead/hours/')) return res(hoursPage(u));
    if (u.includes('/_services/entity-subgrid-data.json/')) {
      const body = JSON.parse(opts.body);
      const f = subgridFor(body.base64SecureConfiguration);
      if (!f || body.page > 1) return res(JSON.stringify({ Records: [], MoreRecords: false, ItemCount: 0 }), 'application/json');
      return res(JSON.stringify({ ...JSON.parse(fx(f)), MoreRecords: false }), 'application/json');
    }
    if (u.includes('volunteers-by-group-csv-feed')) return res(fx('roster.csv'), 'text/csv');
    if (u.includes('participation-reports-csv-feed')) return res(fx('hours.csv'), 'text/csv');
    if (u.includes('qualifications-gained-csv-feed')) return res(u.includes('next90days') ? fx('certs.csv') : '"Qualified Contact","Qualification","Effective Date","Expiration Date"\n', 'text/csv');
    if (u.includes('verified-qualifications-csv-feed')) return res('"Ceritificate Id","Volunteer","Qualification","Issue Date","Type (Qualification)","Expiry Date","Document"\n', 'text/csv');
    if (u.includes('/_portal/modal-form-template-path/')) {
      if ((opts.method || 'GET').toUpperCase() === 'POST') return res(page('<span id="MessageLabel">Submission completed successfully.</span>'));
      return res(page(fx('approveShiftForm.html')));
    }
    return res('not found', 'text/html', 404, u);
  }
  return { fetch, log, override: (test, respond) => overrides.unshift({ test, respond }), clear: () => { overrides.length = 0; log.length = 0; } };
}

async function main() {
  const src = fs.readFileSync(path.join(ROOT, 'd0007-ops.user.js'), 'utf8');
  const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
  let failed = 0, passed = 0;
  for (const f of files) {
    const dom = new JSDOM(page('<p>portal</p>'), { url: 'https://volunteer-sja.powerappsportals.com/en-US/', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    const mock = makeMock();
    w.fetch = mock.fetch;
    w.localStorage.clear();
    w.eval(src);
    const isDate = v => Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v);
    const t = { D0007: w.D0007, window: w, document: w.document, assert, isDate, fetchLog: mock.log, mock, GROUP_ID, fx };
    const tests = require(path.join(__dirname, f));
    for (const [name, fn] of Object.entries(tests)) {
      mock.clear();   // overrides and the fetch log are per test
      try { await fn(t); passed++; console.log(`  ok   ${f} › ${name}`); }
      catch (e) { failed++; console.log(`  FAIL ${f} › ${name}\n       ${(e.stack || e).toString().split('\n').slice(0, 4).join('\n       ')}`); }
    }
    w.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
