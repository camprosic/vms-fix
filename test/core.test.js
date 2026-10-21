// Smoke tests for the data layer against the fixture portal.
module.exports = {
  async 'exports the registry'({ D0007, assert }) {
    assert.ok(D0007.VMS && D0007.open && D0007.version);
  },
  async 'group events come from the four subgrids'({ D0007, assert, isDate }) {
    const ev = await D0007.VMS.groupEvents();
    assert.strictEqual(ev.upcoming.length, 3);
    assert.ok(isDate(ev.upcoming[0].start), 'start parsed from /Date(ms)/');
    assert.ok(ev.upcoming[0].title);
  },
  async 'upcoming engagements map public ids onto event ids'({ D0007, assert }) {
    const [ev, up] = await Promise.all([D0007.VMS.groupEvents(), D0007.VMS.upcomingEngagements()]);
    assert.strictEqual(up.length, 3);
    assert.ok(up.some(u => ev.upcoming.some(e => e.id === u.id)), 'at least one joins');
    assert.ok(typeof up[0].needed === 'number');
  },
  async 'event detail has participants and shifts'({ D0007, assert, isDate }) {
    const d = await D0007.VMS.eventDetail('any');
    assert.strictEqual(d.participants.length, 3);
    assert.strictEqual(d.shifts.length, 3);
    assert.ok(isDate(d.shifts[0].start));
    assert.ok(d.participants[0].name.startsWith('Test Volunteer'));
  },
  async 'csv feeds parse'({ D0007, assert }) {
    const [r, h, c] = await Promise.all([D0007.VMS.roster(), D0007.VMS.hours(''), D0007.VMS.certifications()]);
    assert.strictEqual(r.length, 2); assert.ok(r[0].email);
    assert.strictEqual(h.length, 2); assert.ok(typeof h[0].completed === 'number');
    assert.ok(c.length >= 2); assert.ok(c[0].expiry);
  },
  async 'console opens and renders the events tab'({ D0007, document, assert }) {
    D0007.open();
    await new Promise(r => setTimeout(r, 300));
    assert.ok(document.querySelector('#d0007-root .card h3'), 'an event card rendered');
    assert.ok(document.querySelector('#d0007-launch'), 'launcher present');
  },
};
module.exports['event extras, public ids, the public page and pending requests'] = async ({ D0007, assert, isDate }) => {
  const ev = await D0007.VMS.groupEvents();
  const ids = ev.upcoming.map(e => e.id);
  const extras = await D0007.VMS.eventExtras(ids);
  assert.strictEqual(extras.get(ids[0]).street, '64 Melrose Ave N');
  const pub = await D0007.VMS.publicIdsFor(ids);
  assert.ok(pub.get(ids[0]));
  const pe = await D0007.VMS.publicEvent(pub.get(ids[0]));
  assert.strictEqual(pe.shifts.length, 2);
  assert.strictEqual(pe.shifts[0].name, 'MFR'); assert.strictEqual(pe.shifts[0].max, 10); assert.strictEqual(pe.shifts[0].booked, 3);
  assert.strictEqual(pe.shifts[1].max, 4); assert.strictEqual(pe.shifts[1].booked, 5, 'over-booked shifts show booked > max');
  assert.ok(isDate(pe.shifts[0].start) && isDate(pe.shifts[0].end));
  assert.strictEqual(pe.description, 'Tiger Cat CFL Game');
  assert.deepEqual(pe.quals, []);
  assert.ok(/Hamilton Stadium/.test(pe.location));
  const reqs = await D0007.VMS.pendingRequests();
  assert.strictEqual(reqs.length, 2);
  assert.strictEqual(reqs[0].contact.name, 'Casey Contact'); assert.strictEqual(reqs[0].contact.phone, '555-0101');
  assert.strictEqual(reqs[0].organizer.organization, 'Example Events Inc.');
  assert.strictEqual(reqs[0].address.street, '1479 Baseline Rd');
  assert.strictEqual(typeof reqs[0].onSite.parking, 'boolean');
};
