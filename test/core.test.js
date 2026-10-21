// Smoke tests for the data layer against the fixture portal.
module.exports = {
  async 'exports the registry'({ D0007, assert }) {
    assert.ok(D0007.VMS && D0007.Store && D0007.open && D0007.version);
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
  async 'store round-trips through export/import'({ D0007, assert, window }) {
    const S = D0007.Store;
    S.set('schedule', 'e1|2026-10-24', { meetSJ: '12:00', kits: 'HWP 43' });
    S.patch('members', 'test volunteer 01', { tags: ['C'] });
    const dump = S.exportJSON();
    S.reset();
    assert.strictEqual(S.get('schedule', 'e1|2026-10-24'), undefined);
    S.importJSON(dump);
    assert.strictEqual(JSON.stringify(S.get('schedule', 'e1|2026-10-24')), JSON.stringify({ meetSJ: '12:00', kits: 'HWP 43' }));
    assert.strictEqual(JSON.stringify(S.get('members', 'test volunteer 01').tags), '["C"]');
    assert.ok(window.localStorage.getItem(S.KEY));
  },
  async 'console opens and renders the events tab'({ D0007, document, assert }) {
    D0007.open();
    await new Promise(r => setTimeout(r, 300));
    assert.ok(document.querySelector('#d0007-root .card h3'), 'an event card rendered');
    assert.ok(document.querySelector('#d0007-launch'), 'launcher present');
  },
};
