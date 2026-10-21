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
      box.innerHTML = `
        ${d.description ? `<p class="muted" style="margin:0 0 8px">${esc(d.description)}</p>` : ''}
        <div class="bar"><b>Sign-ups (${d.participants.length})</b> ${Object.entries(byStatus).map(([k, v]) => statusPill(`${k}: ${v}`)).join(' ')}</div>
        ${d.participants.length ? `<div class="tbl"><table><thead><tr><th>Volunteer</th><th>Status</th><th>Signed up</th><th class="n">Hours</th><th class="n">Pending</th></tr></thead><tbody>
          ${d.participants.map(p => `<tr><td>${esc(p.name)}</td><td>${statusPill(p.status)}</td><td>${esc(fmtD(p.signedUp))}</td><td class="n">${p.hours || ''}</td><td class="n">${p.pendingHours || ''}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="muted">Nobody has signed up yet.</div>'}
        ${d.shifts.length ? `<div class="bar" style="margin-top:12px"><b>Reported shifts (${d.shifts.length})</b></div><div class="tbl"><table><thead><tr><th>Volunteer</th><th>Start</th><th class="n">Hours</th><th>Status</th></tr></thead><tbody>
          ${d.shifts.map(s => `<tr><td>${esc(s.name)}</td><td>${esc(fmtDT(s.start))}</td><td class="n">${s.hours || ''}</td><td>${statusPill(s.status)}${/pending/i.test(s.status) ? ` <button class="btn ap-go" data-approve="${esc(title)}" title="Open this event's pending shifts on the Hours tab">Approve…</button>` : ''}</td></tr>`).join('')}
        </tbody></table></div>` : ''}`;
      // Pending rows jump to the Hours tab filtered to this event so you can
      // approve an event right after looking at who was actually on it.
      box.querySelectorAll('[data-approve]').forEach(b => b.addEventListener('click', () => { state.pendingSearch = b.dataset.approve; state.tab = 'hours'; state.q = ''; render(); }));
    } catch (e) { box.innerHTML = `<div class="err">${esc(e.message || e)}</div>`; }
  }
  const CSS_ID = s => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  TABS.push({ id: 'events', label: 'Events', render: renderEvents });
