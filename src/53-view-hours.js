  // ---- Hours ----
  // Two things on this tab. The top is the pending-approval queue, which is
  // the one place this script writes to VMS (the mechanics are in
  // 22-approve.js). Below it, collapsed, is the hours report that used to be
  // the whole tab.
  //
  // Nothing is written until the person presses Submit, reads the list of
  // exactly what will change, and presses Confirm. Each row's start/end/hours
  // come from the shift's own approval form (read when the row is first
  // touched), not from the list page, so what's shown is what gets sent.
  const AP = { list: null, total: 0, truncated: false, progress: '', error: null, rows: new Map(), closed: new Set(), confirm: null, running: null, lastRun: null, reportOpen: false, loadToken: 0, evHours: {}, reportRows: [] };
  const AP_STATUSES = [[Approvals.STATUS.APPROVED, 'Approve'], [Approvals.STATUS.NO_SHOW, 'No show'], [Approvals.STATUS.CANCELLED, 'Cancel'], [Approvals.STATUS.PENDING, 'Leave pending']];
  const AP_SPIN = ' <span class="ap-spin" title="Reading the shift from VMS…"></span>';

  const apRow = item => ({ id: item.shiftId, item, form: null, formLoading: false, formError: null, formPromise: null, sel: false, status: Approvals.STATUS.APPROVED, edits: {}, timesOpen: false, result: null });
  // Until the form has been read, the list page's start and hours stand in.
  const apBase = r => r.form || { start: r.item.start, end: r.item.start ? new Date(r.item.start.getTime() + r.item.hours * 3600000) : null, hours: r.item.hours, status: Approvals.STATUS.PENDING };
  function apView(r) { try { return { v: Approvals.plan(apBase(r), { ...r.edits, status: r.status }), err: null }; } catch (e) { return { v: null, err: e.message || String(e) }; } }
  const apShown = r => { const { v, err } = apView(r); const b = apBase(r); return { start: v ? v.start : (r.edits.start || b.start), end: v ? v.end : (r.edits.end || b.end), hours: v ? v.hours : (r.edits.hours ?? b.hours), err }; };
  function apMsg(r, err) {
    if (r.formError) return 'Couldn\'t read the shift form: ' + r.formError;
    if (r.form && r.form.status !== Approvals.STATUS.PENDING) return `VMS now has this shift as ${Approvals.STATUS_LABEL[r.form.status] || r.form.status}, not Pending. Reload the list.`;
    if (err) return err;
    if (r.result && !r.result.ok) return r.result.error;
    return '';
  }
  const apSelected = () => [...AP.rows.values()].filter(r => r.sel);
  const apBusy = () => !!(AP.confirm || AP.running);

  // Entry from the tab bar or Refresh: start over.
  async function renderHours() {
    if (AP.running) { await paintHours(); return; }   // a batch is mid-flight; just show it
    Object.assign(AP, { list: null, error: null, confirm: null, running: null, rows: new Map(), progress: '' });
    await apLoad();
  }
  // keepRows keeps selections, edits and results for shifts still pending
  // (used after a run and by Reload); quiet leaves the current list on screen
  // while the new one comes in.
  async function apLoad({ keepRows = false, quiet = false } = {}) {
    const token = ++AP.loadToken;
    const prev = AP.rows;
    AP.error = null; AP.progress = 'Loading pending shifts…';
    if (!quiet) { AP.list = null; AP.rows = new Map(); }
    await paintHours();
    try {
      const list = await Approvals.pending({ onPage: p => {
        if (token !== AP.loadToken) return;
        AP.total = p.total; AP.truncated = p.truncated; AP.progress = `Loaded ${p.loaded} of ${p.total}…`;
        const n = main.querySelector('#ap-progress'); if (n) n.textContent = AP.progress;
      } });
      if (token !== AP.loadToken) return;
      AP.list = list; AP.rows = new Map(); AP.progress = '';
      // (a form read still in flight belongs to the old row object; the new one just reads again when touched)
      for (const it of list) { const old = keepRows && prev.get(it.shiftId); AP.rows.set(it.shiftId, old ? { ...old, item: it, form: null, formLoading: false, formPromise: null } : apRow(it)); }
      // (edits and selection carry over; the form snapshot doesn't, so the next touch reads it fresh)
    } catch (e) { if (token !== AP.loadToken) return; AP.error = e.message || String(e); AP.progress = ''; }
    await paintHours();
  }

  // --- the shift form, read lazily, three at a time ---
  const apQueue = []; let apInFlight = 0;
  function apPump() { while (apInFlight < 3 && apQueue.length) { apInFlight++; apQueue.shift()().finally(() => { apInFlight--; apPump(); }); } }
  function apEnsureForm(r) {
    if (r.form) return Promise.resolve(r.form);
    if (r.formLoading) return r.formPromise;
    r.formLoading = true; r.formError = null; apRowDom(r);
    r.formPromise = new Promise(resolve => apQueue.push(() => Approvals.loadForm(r.id)
      .then(f => { r.form = f; }, e => { r.formError = e.message || String(e); })
      .then(() => { r.formLoading = false; apRowDom(r); resolve(r.form); })));
    apPump();
    return r.formPromise;
  }

  // --- painting ---
  async function paintHours() {
    if (state.tab !== 'hours' || !main) return;
    let report = '';
    if (AP.reportOpen) { try { report = await hoursReportHTML(); } catch (e) { report = `<div class="err">${esc(e.message || e)}</div>`; } }
    if (state.tab !== 'hours') return;
    main.innerHTML = `<div class="wrap">
      <div class="bar"><h2 class="ap-h">Pending approvals${AP.list ? ` <span class="pill amber">${AP.list.length}</span>` : ''}</h2><span class="sp"></span>
        <input type="search" id="ap-q" placeholder="Filter by volunteer or event…" value="${esc(state.pendingSearch || '')}" ${AP.list ? '' : 'disabled'}>
        <button class="btn" id="ap-reload" title="Re-read the pending list from VMS (keeps your edits)" ${apBusy() ? 'disabled' : ''}>Reload</button></div>
      ${AP.error ? `<div class="err"><b>Couldn't load the pending list.</b> ${esc(AP.error)}</div>` : ''}
      ${AP.list ? `<div class="muted ap-progress" id="ap-progress">${esc(AP.progress)}</div>` : AP.error ? '' : `<div class="load" id="ap-progress">${esc(AP.progress || 'Loading pending shifts…')}</div>`}
      ${AP.truncated ? `<div class="err">VMS has ${AP.total} pending shifts and this shows the first ${AP.list ? AP.list.length : ''}. Approve some and reload for the rest.</div>` : ''}
      ${apLastRunHTML()}
      ${apConfirmHTML()}
      <div id="ap-groups">${AP.list ? apGroupsHTML() : ''}</div>
      ${AP.list ? apActionsHTML() : ''}
      <div class="card ap-report">
        <div class="bar" style="margin:0"><button class="btn" id="ap-report-tog">${AP.reportOpen ? 'Hide hours report' : 'Hours report ▸'}</button><span class="muted">Completed and pending hours by volunteer or by event, from Reports → Volunteer Hours.</span></div>
        ${AP.reportOpen ? report : ''}
      </div>
    </div>`;
    bindApprovals();
    if (AP.reportOpen) bindHoursReport();
  }
  function apGroupsHTML() {
    const q = state.pendingSearch || '';
    const rows = [...AP.rows.values()].filter(r => matches(q, r.item.name, r.item.event));
    if (!rows.length) return `<div class="card muted">${AP.rows.size ? 'Nothing matches that filter.' : 'Nothing is waiting for approval.'}</div>`;
    const groups = new Map();
    for (const r of rows) {
      const k = r.item.event || '—';
      if (!groups.has(k)) groups.set(k, { event: k, rows: [], latest: 0 });
      const g = groups.get(k); g.rows.push(r); g.latest = Math.max(g.latest, r.item.start?.getTime() || 0);
    }
    AP.groups = [...groups.values()].sort((a, b) => b.latest - a.latest);
    AP.groups.forEach(g => g.rows.sort((a, b) => ((a.item.start?.getTime() || 0) - (b.item.start?.getTime() || 0)) || norm(a.item.name).localeCompare(norm(b.item.name))));
    const dis = apBusy() ? 'disabled' : '';
    return AP.groups.map((g, i) => apGroupHTML(g, i, dis)).join('');
  }
  function apGroupHTML(g, i, dis) {
    const closed = AP.closed.has(g.event);
    const nSel = g.rows.filter(r => r.sel).length;
    return `<div class="card ap-group" data-g="${i}">
      <div class="ap-ghead">
        <button class="ap-tog" data-tog="${i}" aria-expanded="${!closed}" title="${closed ? 'Show' : 'Hide'} shifts">${closed ? '▸' : '▾'}</button>
        <div class="ap-gtitle"><b>${esc(g.event)}</b><span class="muted">${esc(fmtD(new Date(g.latest)))} · ${g.rows.length} shift${g.rows.length === 1 ? '' : 's'} · <span data-gsel="${i}">${nSel}</span> selected</span></div>
        <span class="sp"></span>
        <label class="ap-evh">Set hours for all <input type="number" step="0.25" min="0" data-evh="${i}" value="${esc(AP.evHours[g.event] ?? '')}" ${dis}> <button class="btn" data-evh-apply="${i}" ${dis}>Apply</button></label>
        <button class="btn" data-selall="${i}" ${dis}>${nSel === g.rows.length ? 'Select none' : 'Select all'}</button>
        <button class="btn" data-approveall="${i}" ${dis} title="Select every shift here, hours as the volunteers reported them, status Approve">Approve all as reported</button>
      </div>
      ${closed ? '' : `<div class="tbl ap-tbl"><table><thead><tr><th></th><th>Volunteer</th><th>Start</th><th>End</th><th class="n">Hours</th><th>Action</th><th></th></tr></thead><tbody>${g.rows.map(r => apRowHTML(r, dis)).join('')}</tbody></table></div>`}
    </div>`;
  }
  const apMark = r => !r.result ? '' : r.result.ok ? '<span class="ap-ok" title="Updated in VMS">✓</span>' : `<span class="ap-bad" title="${esc(r.result.error)}">✗</span>`;
  function apRowHTML(r, dis) {
    const s = apShown(r);
    return `<tr class="ap-row${r.sel ? ' sel' : ''}" data-id="${esc(r.id)}">
      <td><input type="checkbox" data-sel ${r.sel ? 'checked' : ''} ${dis}></td>
      <td><div class="ap-name">${apMark(r)}${esc(r.item.name)}${r.formLoading ? AP_SPIN : ''}</div><div class="muted ap-sub">${esc(r.form ? r.form.scheduleName : '')}</div><div class="ap-msg">${esc(apMsg(r, s.err))}</div></td>
      <td class="ap-start">${esc(fmtDT(s.start))}</td>
      <td class="ap-end">${esc(fmtDT(s.end))}</td>
      <td class="n"><input type="number" step="0.25" min="0" data-hours value="${esc(s.hours)}" ${dis}></td>
      <td><select data-status ${dis}>${AP_STATUSES.map(([v, l]) => `<option value="${v}" ${r.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td><button class="lnk" data-times ${dis}>${r.timesOpen ? 'hide times' : 'edit times'}</button></td>
    </tr>
    <tr class="ap-times" data-times-for="${esc(r.id)}" ${r.timesOpen ? '' : 'hidden'}><td></td><td colspan="6">
      <label>Start <input type="datetime-local" data-start value="${esc(Approvals.toLocalInput(s.start))}" ${dis}></label>
      <label>End <input type="datetime-local" data-end value="${esc(Approvals.toLocalInput(s.end))}" ${dis}></label>
      <span class="muted">Eastern. Changing the end recalculates hours; changing hours recalculates the end.</span></td></tr>`;
  }
  function apActionsHTML() {
    const n = apSelected().length;
    const hidden = apSelected().filter(r => !matches(state.pendingSearch || '', r.item.name, r.item.event)).length;
    return `<div class="ap-actions" id="ap-actions"><b id="ap-count">${n} selected${hidden ? ` (${hidden} hidden by the filter)` : ''}</b><span class="sp"></span>
      <button class="btn" id="ap-clear" ${n && !apBusy() ? '' : 'disabled'}>Clear selection</button>
      <button class="btn primary" id="ap-submit" ${n && !apBusy() ? '' : 'disabled'}>Submit ${n} change${n === 1 ? '' : 's'}</button></div>`;
  }
  function apChangeLine(name, event, p, form) {
    const moved = form && (p.start.getTime() !== form.start?.getTime() || p.end.getTime() !== form.end?.getTime());
    return `${esc(name)} — ${esc(event)} — ${p.hours.toFixed(2)} h${moved ? ` (${esc(fmtDT(p.start))} – ${esc(fmtT(p.end))})` : ''} → ${esc(Approvals.STATUS_LABEL[p.status])}`;
  }
  function apConfirmHTML() {
    if (AP.running) {
      const { i, n } = AP.running;
      return `<div class="card ap-confirm" id="ap-run"><h3>Writing to VMS…</h3><div class="staff"><span class="ap-run-n">${i} of ${n}</span><div class="track"><i style="width:${n ? Math.round(100 * i / n) : 0}%"></i></div></div><p class="muted">One shift at a time. Leave this tab open until it finishes.</p></div>`;
    }
    if (!AP.confirm) return '';
    if (AP.confirm.loading) return `<div class="card ap-confirm"><h3>Checking the shifts…</h3><div class="load">Reading each shift's approval form from VMS so the list below is exactly what will be sent.</div></div>`;
    const ok = AP.confirm.items.filter(i => i.plan && !i.noop), skipped = AP.confirm.items.filter(i => !i.plan || i.noop);
    return `<div class="card ap-confirm">
      <h3>Write ${ok.length} change${ok.length === 1 ? '' : 's'} to VMS?</h3>
      ${ok.length ? `<ul class="plain">${ok.map(i => `<li><span>${apChangeLine(i.r.item.name, i.r.item.event, i.plan, i.r.form)}</span></li>`).join('')}</ul>` : ''}
      ${skipped.length ? `<div class="muted" style="margin-bottom:6px">Not being sent:</div><ul class="plain">${skipped.map(i => `<li><span>${esc(i.r.item.name)} — ${esc(i.r.item.event)}</span><span class="pill ${i.noop ? 'grey' : 'red'}">${esc(i.noop ? 'no change' : i.err)}</span></li>`).join('')}</ul>` : ''}
      <p>Confirm sends each of these to VMS as you, one at a time, through the same approval form the Hours page uses. A shift approved here can't be put back to pending from this screen.</p>
      <div class="bar" style="margin:0"><button class="btn primary" id="ap-confirm" ${ok.length ? '' : 'disabled'}>Confirm</button><button class="btn" id="ap-cancel">Cancel</button></div>
    </div>`;
  }
  function apLastRunHTML() {
    const l = AP.lastRun; if (!l) return '';
    return `<div class="card ap-last"><div class="bar" style="margin:0 0 6px"><b>Last run: ${l.done.length} updated, ${l.failed.length} failed</b><span class="muted">${esc(fmtDT(l.at))}</span><span class="sp"></span><button class="btn" id="ap-last-close">Dismiss</button></div>
      <ul class="plain">${l.done.map(d => `<li><span class="ap-ok">✓</span><span>${apChangeLine(d.name, d.event, d.values, null)}</span></li>`).join('')}${l.failed.map(f => `<li><span class="ap-bad">✗</span><span>${esc(f.name)} — ${esc(f.event)}</span><span class="pill red">${esc(f.error)}</span></li>`).join('')}</ul></div>`;
  }

  // In-place updates so typing in one row doesn't repaint the screen.
  function apRowDom(r, { keepHours = false } = {}) {
    if (AP.rows.get(r.id) !== r) return;   // an older copy of this row (a reload happened); its DOM isn't ours
    const tr = main && main.querySelector(`tr.ap-row[data-id="${r.id}"]`); if (!tr) return;
    const s = apShown(r);
    tr.classList.toggle('sel', r.sel);
    tr.querySelector('[data-sel]').checked = r.sel;
    tr.querySelector('.ap-start').textContent = fmtDT(s.start);
    tr.querySelector('.ap-end').textContent = fmtDT(s.end);
    if (!keepHours) tr.querySelector('[data-hours]').value = s.hours;
    tr.querySelector('[data-status]').value = r.status;
    tr.querySelector('.ap-name').innerHTML = `${apMark(r)}${esc(r.item.name)}${r.formLoading ? AP_SPIN : ''}`;
    tr.querySelector('.ap-sub').textContent = r.form ? r.form.scheduleName : '';
    tr.querySelector('.ap-msg').textContent = apMsg(r, s.err);
    tr.querySelector('[data-times]').textContent = r.timesOpen ? 'hide times' : 'edit times';
    const tt = main.querySelector(`tr.ap-times[data-times-for="${r.id}"]`);
    if (tt) { tt.hidden = !r.timesOpen; tt.querySelector('[data-start]').value = Approvals.toLocalInput(s.start); tt.querySelector('[data-end]').value = Approvals.toLocalInput(s.end); }
  }
  function apCounts() {
    const n = apSelected().length;
    const hidden = apSelected().filter(r => !matches(state.pendingSearch || '', r.item.name, r.item.event)).length;
    const c = main.querySelector('#ap-count'); if (c) c.textContent = `${n} selected${hidden ? ` (${hidden} hidden by the filter)` : ''}`;
    const b = main.querySelector('#ap-submit'); if (b) { b.textContent = `Submit ${n} change${n === 1 ? '' : 's'}`; b.disabled = !n || apBusy(); }
    const cl = main.querySelector('#ap-clear'); if (cl) cl.disabled = !n || apBusy();
    (AP.groups || []).forEach((g, i) => { const k = g.rows.filter(r => r.sel).length; const s = main.querySelector(`[data-gsel="${i}"]`); if (s) s.textContent = k; const sa = main.querySelector(`[data-selall="${i}"]`); if (sa) sa.textContent = k === g.rows.length ? 'Select none' : 'Select all'; });
  }
  function apTouch(r) { r.sel = true; apEnsureForm(r); }

  function bindApprovals() {
    const q = main.querySelector('#ap-q');
    if (q) q.addEventListener('input', () => { state.pendingSearch = q.value; const g = main.querySelector('#ap-groups'); if (g) { g.innerHTML = apGroupsHTML(); bindGroups(); apCounts(); } });
    main.querySelector('#ap-reload')?.addEventListener('click', () => apLoad({ keepRows: true, quiet: true }));
    main.querySelector('#ap-report-tog')?.addEventListener('click', () => { AP.reportOpen = !AP.reportOpen; paintHours(); });
    main.querySelector('#ap-last-close')?.addEventListener('click', () => { AP.lastRun = null; paintHours(); });
    main.querySelector('#ap-submit')?.addEventListener('click', apBeginConfirm);
    main.querySelector('#ap-clear')?.addEventListener('click', () => { AP.rows.forEach(r => { r.sel = false; }); main.querySelector('#ap-groups').innerHTML = apGroupsHTML(); bindGroups(); apCounts(); });
    main.querySelector('#ap-confirm')?.addEventListener('click', apRun);
    main.querySelector('#ap-cancel')?.addEventListener('click', () => { AP.confirm = null; paintHours(); });
    bindGroups();
  }
  function bindGroups() {
    const g = main.querySelector('#ap-groups'); if (!g) return;
    const repaint = () => { g.innerHTML = apGroupsHTML(); bindGroups(); apCounts(); };
    g.querySelectorAll('[data-tog]').forEach(b => b.addEventListener('click', () => { const ev = AP.groups[+b.dataset.tog].event; if (AP.closed.has(ev)) AP.closed.delete(ev); else AP.closed.add(ev); repaint(); }));
    g.querySelectorAll('[data-selall]').forEach(b => b.addEventListener('click', () => { const grp = AP.groups[+b.dataset.selall]; const all = grp.rows.every(r => r.sel); grp.rows.forEach(r => { r.sel = !all; if (!all) apEnsureForm(r); }); repaint(); }));
    g.querySelectorAll('[data-approveall]').forEach(b => b.addEventListener('click', () => { const grp = AP.groups[+b.dataset.approveall]; grp.rows.forEach(r => { r.sel = true; r.status = Approvals.STATUS.APPROVED; r.edits = {}; apEnsureForm(r); }); repaint(); }));
    g.querySelectorAll('[data-evh]').forEach(inp => inp.addEventListener('input', () => { AP.evHours[AP.groups[+inp.dataset.evh].event] = inp.value; }));
    g.querySelectorAll('[data-evh-apply]').forEach(b => b.addEventListener('click', () => {
      const grp = AP.groups[+b.dataset.evhApply]; const v = Number(AP.evHours[grp.event]);
      if (!(AP.evHours[grp.event] !== '' && isFinite(v) && v >= 0)) return;
      grp.rows.forEach(r => { r.edits.hours = v; delete r.edits.end; apTouch(r); });
      repaint();
    }));
    g.querySelectorAll('tr.ap-row').forEach(tr => {
      const r = AP.rows.get(tr.dataset.id); if (!r) return;
      tr.querySelector('[data-sel]').addEventListener('change', e => { r.sel = e.target.checked; if (r.sel) apEnsureForm(r); apRowDom(r); apCounts(); });
      const hrs = tr.querySelector('[data-hours]');
      const takeHours = () => { const n = Number(hrs.value); if (hrs.value === '') delete r.edits.hours; else if (isFinite(n)) { r.edits.hours = n; delete r.edits.end; } apTouch(r); };
      hrs.addEventListener('input', () => { takeHours(); apRowDom(r, { keepHours: true }); apCounts(); });
      hrs.addEventListener('change', () => { takeHours(); apRowDom(r); apCounts(); });
      tr.querySelector('[data-status]').addEventListener('change', e => { r.status = e.target.value; apTouch(r); apRowDom(r); apCounts(); });
      tr.querySelector('[data-times]').addEventListener('click', () => { r.timesOpen = !r.timesOpen; apEnsureForm(r); apRowDom(r); });
      const tt = g.querySelector(`tr.ap-times[data-times-for="${r.id}"]`); if (!tt) return;
      tt.querySelector('[data-start]').addEventListener('change', e => { const d = Approvals.fromLocalInput(e.target.value); if (d) r.edits.start = d; else delete r.edits.start; apTouch(r); apRowDom(r); apCounts(); });
      tt.querySelector('[data-end]').addEventListener('change', e => { const d = Approvals.fromLocalInput(e.target.value); if (d) { r.edits.end = d; delete r.edits.hours; } else delete r.edits.end; apTouch(r); apRowDom(r); apCounts(); });
    });
  }

  // --- submit → confirm → run ---
  async function apBeginConfirm() {
    const sel = apSelected(); if (!sel.length || apBusy()) return;
    AP.confirm = { loading: true, items: [] };
    await paintHours();
    // Always read the forms again here: the panel must describe VMS as it is
    // now, not as it was when the row was first clicked.
    sel.forEach(r => { r.form = null; r.formError = null; });
    await Promise.all(sel.map(apEnsureForm));
    if (!AP.confirm || !AP.confirm.loading) return;   // cancelled meanwhile
    AP.confirm = { loading: false, items: sel.map(r => {
      if (!r.form) return { r, err: 'Couldn\'t read the shift form: ' + (r.formError || 'unknown error') };
      if (r.form.status !== Approvals.STATUS.PENDING) return { r, err: `Already ${Approvals.STATUS_LABEL[r.form.status] || r.form.status} in VMS` };
      if (r.form.participation && !norm(r.form.participation).startsWith(norm(r.item.name))) return { r, err: `The form is for "${r.form.participation}", not this row` };
      try {
        const p = Approvals.plan(r.form, { ...r.edits, status: r.status });
        const same = (a, b) => (!a && !b) || (a && b && a.getTime() === b.getTime());
        const noop = p.status === r.form.status && p.hours === r2(r.form.hours) && same(p.start, r.form.start) && same(p.end, r.form.end);
        return { r, plan: p, noop };
      } catch (e) { return { r, err: e.message || String(e) }; }
    }) };
    await paintHours();
  }
  async function apRun() {
    if (!AP.confirm || AP.confirm.loading || AP.running) return;
    const items = AP.confirm.items.filter(i => i.plan && !i.noop);
    if (!items.length) { AP.confirm = null; paintHours(); return; }
    AP.confirm = null; AP.running = { i: 0, n: items.length };
    await paintHours();
    const res = await Approvals.run(items.map(i => ({ shiftId: i.r.id, values: i.plan, row: i.r, expect: { status: Approvals.STATUS.PENDING, start: i.r.form.start, end: i.r.form.end, hours: i.r.form.hours, name: i.r.item.name } })), {
      onProgress: (idx, result) => {
        const r = items[idx].r; r.result = result; if (AP.running) AP.running.i = idx + 1;
        apRowDom(r);
        const n = main.querySelector('#ap-run .ap-run-n'); if (n) n.textContent = `${idx + 1} of ${items.length}`;
        const bar = main.querySelector('#ap-run .track i'); if (bar) bar.style.width = `${Math.round(100 * (idx + 1) / items.length)}%`;
      },
    });
    AP.running = null;
    AP.lastRun = { at: new Date(), done: res.done.map(d => ({ name: d.row.item.name, event: d.row.item.event, values: d.values })), failed: res.failed.map(f => ({ name: f.row.item.name, event: f.row.item.event, error: f.error })) };
    // Done ones leave the queue now; the reload below is the real check.
    for (const d of res.done) AP.rows.delete(d.shiftId);
    AP.list = AP.list.filter(it => AP.rows.has(it.shiftId));
    for (const f of res.failed) { const r = AP.rows.get(f.shiftId); if (r) { r.sel = true; r.form = null; } }   // re-read the form before any retry
    await paintHours();
    apLoad({ keepRows: true, quiet: true });
  }

  // --- the hours report (unchanged, just folded under a toggle) ---
  async function hoursReportHTML() {
    const hrs = await VMS.hours(state.hoursWin);
    const q = state.q;
    const key = state.hoursBy === 'volunteer' ? 'name' : 'event';
    const agg = new Map();
    for (const h of hrs) { const k = h[key]; const a = agg.get(k) || { label: k, completed: 0, pending: 0, count: 0, items: new Set() }; a.completed += h.completed; a.pending += h.pending; a.count++; a.items.add(h[key === 'name' ? 'event' : 'name']); agg.set(k, a); }
    const rows = sortRows([...agg.values()].map(a => ({ ...a, n: a.items.size })).filter(a => matches(q, a.label)), 'hours', 'completed', -1);
    AP.reportRows = rows;
    const totC = r2(hrs.reduce((a, h) => a + h.completed, 0)), totP = r2(hrs.reduce((a, h) => a + h.pending, 0));
    const winLabel = { '': 'Last 12 months', '90days': 'Last 90 days', '30days': 'Last 30 days' };
    return `<div class="ap-report-body">
      <div class="stats"><div class="stat"><b>${totC}</b><span>completed hours</span></div><div class="stat ${totP ? 'warn' : ''}"><b>${totP}</b><span>pending approval</span></div><div class="stat"><b>${new Set(hrs.map(h => h.name)).size}</b><span>volunteers active</span></div><div class="stat"><b>${new Set(hrs.map(h => h.event)).size}</b><span>events</span></div></div>
      <div class="bar">
        <div class="seg">${['', '90days', '30days'].map(w => `<button data-win="${w}" class="${state.hoursWin === w ? 'on' : ''}">${winLabel[w]}</button>`).join('')}</div>
        <div class="seg"><button data-by="volunteer" class="${state.hoursBy === 'volunteer' ? 'on' : ''}">By volunteer</button><button data-by="event" class="${state.hoursBy === 'event' ? 'on' : ''}">By event</button></div>
        <input type="search" placeholder="Filter…" value="${esc(q)}"><button class="btn" id="d7-csv">Download CSV</button>
      </div>
      <div class="tbl" id="ap-report-tbl"><table><thead><tr>${th(state.hoursBy === 'volunteer' ? 'Volunteer' : 'Event', 'label', 'hours', 'completed')}${th(state.hoursBy === 'volunteer' ? 'Events' : 'Volunteers', 'n', 'hours', 'completed', true)}${th('Completed hrs', 'completed', 'hours', 'completed', true)}${th('Pending hrs', 'pending', 'hours', 'completed', true)}</tr></thead><tbody>
        ${rows.map(r => `<tr><td>${esc(r.label)}</td><td class="n">${r.n}</td><td class="n"><b>${r2(r.completed)}</b></td><td class="n">${r.pending ? pill(r2(r.pending), 'amber') : '<span class="muted">0</span>'}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted" style="font-size:12px">Source: Group Lead → Reports → Volunteer Hours (approved participations, ${winLabel[state.hoursWin].toLowerCase()}).</p>
    </div>`;
  }
  function bindHoursReport() {
    const box = main.querySelector('.ap-report'); if (!box) return;
    box.querySelectorAll('[data-win]').forEach(b => b.addEventListener('click', () => { state.hoursWin = b.dataset.win; paintHours(); }));
    box.querySelectorAll('[data-by]').forEach(b => b.addEventListener('click', () => { state.hoursBy = b.dataset.by; paintHours(); }));
    // Filtering swaps just the table so the search box keeps focus.
    const inp = box.querySelector('input[type=search]');
    inp.addEventListener('input', async () => {
      state.q = inp.value;
      const tmp = document.createElement('div'); tmp.innerHTML = await hoursReportHTML();
      const cur = box.querySelector('#ap-report-tbl'); if (!cur) return;
      cur.replaceWith(tmp.querySelector('#ap-report-tbl')); bindSort(box.querySelector('#ap-report-tbl'), paintHours);
    });
    bindSort(box, paintHours);
    box.querySelector('#d7-csv').addEventListener('click', () => downloadCSV(`d0007-hours-${state.hoursBy}.csv`, [state.hoursBy === 'volunteer' ? 'Volunteer' : 'Event', 'Count', 'Completed hours', 'Pending hours'], AP.reportRows.map(r => [r.label, r.n, r2(r.completed), r2(r.pending)])));
  }

  CSS_PARTS.push(`
#d0007-root .ap-h{font-size:17px;margin:0}
#d0007-root .bar .sp{flex:1}
#d0007-root .btn.primary{background:#1f4d2b;color:#fff;border-color:#1f4d2b}
#d0007-root .btn.primary:hover{background:#2a6a3b}
#d0007-root .btn:disabled{opacity:.5;cursor:default}
#d0007-root .btn:disabled:hover{background:#fff}
#d0007-root .btn.primary:disabled:hover{background:#1f4d2b}
#d0007-root .lnk{border:0;background:none;color:#2f6b3a;cursor:pointer;font:inherit;font-size:12.5px;padding:2px 4px;text-decoration:underline;white-space:nowrap}
#d0007-root .lnk:disabled{opacity:.5;cursor:default}
#d0007-root .ap-progress{font-size:12.5px;min-height:18px;margin:-6px 0 8px}
#d0007-root .ap-group{padding:0;overflow:hidden}
#d0007-root .ap-ghead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;background:#f7f9f7;border-bottom:1px solid #dfe5e0}
#d0007-root .ap-gtitle{display:flex;flex-direction:column;min-width:0}
#d0007-root .ap-gtitle b{font-size:14.5px}
#d0007-root .ap-gtitle .muted{font-size:12px}
#d0007-root .ap-tog{border:0;background:none;font-size:14px;cursor:pointer;padding:2px 6px;color:#1f4d2b}
#d0007-root .ap-evh{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:#3a4a3d;white-space:nowrap}
#d0007-root .ap-tbl{border:0;border-radius:0;max-height:none}
#d0007-root .ap-tbl th{position:static}
#d0007-root .ap-row.sel td{background:#f2f8f3}
#d0007-root .ap-row input[type=number],#d0007-root .ap-evh input[type=number]{width:74px;border:1px solid #cfd8d0;border-radius:6px;padding:4px 6px;font:inherit;text-align:right;background:#fff}
#d0007-root .ap-row select{border:1px solid #cfd8d0;border-radius:6px;padding:4px 6px;font:inherit;background:#fff}
#d0007-root .ap-row input[type=checkbox]{width:16px;height:16px;margin:4px 0 0}
#d0007-root .ap-name{font-weight:600}
#d0007-root .ap-sub{font-size:11.5px}
#d0007-root .ap-sub:empty{display:none}
#d0007-root .ap-msg{color:#9a2b1d;font-size:12px;margin-top:2px}
#d0007-root .ap-msg:empty{display:none}
#d0007-root .ap-times td{background:#fbfcfb;font-size:12.5px;border-bottom:1px solid #e7ebe7}
#d0007-root .ap-times label{margin-right:10px;white-space:nowrap}
#d0007-root .ap-times input[type=datetime-local]{border:1px solid #cfd8d0;border-radius:6px;padding:4px 6px;font:inherit;font-size:12.5px;background:#fff}
#d0007-root .ap-spin{display:inline-block;width:12px;height:12px;border:2px solid #cfd8d0;border-top-color:#1f4d2b;border-radius:50%;animation:d7spin .8s linear infinite;vertical-align:middle;margin-left:6px}
#d0007-root .ap-ok{color:#1f5a2c;font-weight:700;margin-right:6px}
#d0007-root .ap-bad{color:#9a2b1d;font-weight:700;margin-right:6px}
#d0007-root .ap-actions{position:sticky;bottom:0;background:#fff;border:1px solid #dfe5e0;border-radius:8px;padding:10px 12px;display:flex;gap:10px;align-items:center;margin:8px 0 14px;box-shadow:0 -2px 10px rgba(0,0,0,.06)}
#d0007-root .ap-confirm{border-color:#d9b84a;background:#fffbea}
#d0007-root .ap-confirm h3{margin:0 0 8px;font-size:15px}
#d0007-root .ap-confirm ul.plain{max-height:40vh;overflow:auto;margin-bottom:8px}
#d0007-root .ap-confirm ul.plain li{display:flex;justify-content:flex-start;gap:10px}
#d0007-root .ap-confirm p{margin:8px 0 10px}
#d0007-root .ap-last ul.plain{max-height:30vh;overflow:auto}
#d0007-root .ap-last ul.plain li{justify-content:flex-start}
#d0007-root .ap-last ul.plain li .pill{margin-left:auto}
#d0007-root .ap-report{margin-top:16px}
#d0007-root .ap-report-body{margin-top:12px}
#d0007-root .ap-go{padding:2px 8px;font-size:12px;margin-left:6px}
`);
  TABS.push({ id: 'hours', label: 'Hours', render: renderHours });
