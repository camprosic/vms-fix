  // ---- Events ----
  async function renderEvents() {
    const [ev, up] = await Promise.all([VMS.groupEvents(), VMS.upcomingEngagements().catch(() => [])]);
    if (!stillCurrent('events')) return;
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
      const byStatus = {}; d.participants.forEach(p => { byStatus[p.status || '—'] = (byStatus[p.status || '—'] || 0) + 1; });
      box.innerHTML = `
        ${d.description ? `<p class="muted" style="margin:0 0 8px">${esc(d.description)}</p>` : ''}
        <div class="bar"><b>Sign-ups (${d.participants.length})</b> ${Object.entries(byStatus).map(([k, v]) => statusPill(`${k}: ${v}`)).join(' ')}</div>
        ${d.participants.length ? `<div class="tbl"><table><thead><tr><th>Volunteer</th><th>Status</th><th>Signed up</th><th class="n">Hours</th><th class="n">Pending</th></tr></thead><tbody>
          ${d.participants.map(p => `<tr><td>${esc(p.name)}</td><td>${statusPill(p.status)}</td><td>${esc(fmtD(p.signedUp))}</td><td class="n">${p.hours || ''}</td><td class="n">${p.pendingHours || ''}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="muted">Nobody has signed up yet.</div>'}
        ${d.shifts.length ? `<div class="bar" style="margin-top:12px"><b>Reported shifts (${d.shifts.length})</b></div><div class="tbl"><table><thead><tr><th>Volunteer</th><th>Start</th><th class="n">Hours</th><th>Status</th></tr></thead><tbody>
          ${d.shifts.map(s => `<tr><td>${esc(s.name)}</td><td>${esc(fmtDT(s.start))}</td><td class="n">${s.hours || ''}</td><td>${statusPill(s.status)}</td></tr>`).join('')}
        </tbody></table></div>` : ''}`;
    } catch (e) { box.innerHTML = `<div class="err">${esc(e.message || e)}</div>`; }
  }
  const CSS_ID = s => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  TABS.push({ id: 'events', label: 'Events', render: renderEvents });
