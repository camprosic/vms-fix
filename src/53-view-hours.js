  // ---- Hours ----
  async function renderHours() {
    const hrs = await VMS.hours(state.hoursWin);
    const q = state.q;
    const key = state.hoursBy === 'volunteer' ? 'name' : 'event';
    const agg = new Map();
    for (const h of hrs) { const k = h[key]; const a = agg.get(k) || { label: k, completed: 0, pending: 0, count: 0, items: new Set() }; a.completed += h.completed; a.pending += h.pending; a.count++; a.items.add(h[key === 'name' ? 'event' : 'name']); agg.set(k, a); }
    const rows = sortRows([...agg.values()].map(a => ({ ...a, n: a.items.size })).filter(a => matches(q, a.label)), 'hours', 'completed', -1);
    const totC = r2(hrs.reduce((a, h) => a + h.completed, 0)), totP = r2(hrs.reduce((a, h) => a + h.pending, 0));
    const winLabel = { '': 'Last 12 months', '90days': 'Last 90 days', '30days': 'Last 30 days' };
    main.innerHTML = `<div class="wrap">
      <div class="stats"><div class="stat"><b>${totC}</b><span>completed hours</span></div><div class="stat ${totP ? 'warn' : ''}"><b>${totP}</b><span>pending approval</span></div><div class="stat"><b>${new Set(hrs.map(h => h.name)).size}</b><span>volunteers active</span></div><div class="stat"><b>${new Set(hrs.map(h => h.event)).size}</b><span>events</span></div></div>
      <div class="bar">
        <div class="seg">${['', '90days', '30days'].map(w => `<button data-win="${w}" class="${state.hoursWin === w ? 'on' : ''}">${winLabel[w]}</button>`).join('')}</div>
        <div class="seg"><button data-by="volunteer" class="${state.hoursBy === 'volunteer' ? 'on' : ''}">By volunteer</button><button data-by="event" class="${state.hoursBy === 'event' ? 'on' : ''}">By event</button></div>
        <input type="search" placeholder="Filter…" value="${esc(q)}"><button class="btn" id="d7-csv">Download CSV</button>
      </div>
      <div class="tbl"><table><thead><tr>${th(state.hoursBy === 'volunteer' ? 'Volunteer' : 'Event', 'label', 'hours', 'completed')}${th(state.hoursBy === 'volunteer' ? 'Events' : 'Volunteers', 'n', 'hours', 'completed', true)}${th('Completed hrs', 'completed', 'hours', 'completed', true)}${th('Pending hrs', 'pending', 'hours', 'completed', true)}</tr></thead><tbody>
        ${rows.map(r => `<tr><td>${esc(r.label)}</td><td class="n">${r.n}</td><td class="n"><b>${r2(r.completed)}</b></td><td class="n">${r.pending ? pill(r2(r.pending), 'amber') : '<span class="muted">0</span>'}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted" style="font-size:12px">Source: Group Lead → Reports → Volunteer Hours (approved participations, ${winLabel[state.hoursWin].toLowerCase()}).</p>
    </div>`;
    main.querySelectorAll('[data-win]').forEach(b => b.addEventListener('click', () => { state.hoursWin = b.dataset.win; render(); }));
    main.querySelectorAll('[data-by]').forEach(b => b.addEventListener('click', () => { state.hoursBy = b.dataset.by; renderHours(); }));
    const inp = main.querySelector('input[type=search]'); inp.addEventListener('input', () => { state.q = inp.value; renderHours(); });
    bindSort(main, renderHours);
    main.querySelector('#d7-csv').addEventListener('click', () => downloadCSV(`d0007-hours-${state.hoursBy}.csv`, [state.hoursBy === 'volunteer' ? 'Volunteer' : 'Event', 'Count', 'Completed hours', 'Pending hours'], rows.map(r => [r.label, r.n, r2(r.completed), r2(r.pending)])));
  }
  TABS.push({ id: 'hours', label: 'Hours', render: renderHours });
