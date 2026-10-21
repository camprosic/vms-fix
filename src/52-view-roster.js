  // ---- Roster ----
  // The volunteers page in the portal is a 10-row paginated table with a csv
  // button. This is the csv, on screen, searchable, with hours and certs a
  // click away. Revolutionary stuff.
  //
  // "MFR" here means VMS has a current Medical First Responder cert on file for
  // the person (any of the MFR qualification names). Same test the Schedule tab
  // falls back on when it cant tell which shift someone booked.
  function mfrCertOf(name, certs) {
    const mine = certs.filter(c => norm(c.name) === norm(name) && /medical first responder/i.test(c.qualification) && c.expiry && daysUntil(c.expiry) >= 0);
    return mine.sort((a, b) => (toDate(b.expiry)?.getTime() || 0) - (toDate(a.expiry)?.getTime() || 0))[0] || null;
  }
  async function renderRoster() {
    const [roster, certs] = await Promise.all([VMS.roster(), VMS.certifications().catch(() => [])]);
    if (!stillCurrent('roster')) return;
    roster.forEach(r => { const c = mfrCertOf(r.name, certs); r.mfr = c ? 'MFR' : 'Apprentice'; r.mfrTo = c ? c.expiry : ''; });
    const q = state.q;
    const rows = sortRows(roster.filter(r => matches(q, r.name, r.email, r.phone, r.contactId, r.status, r.mfr)), 'roster', 'name');
    const active = roster.filter(r => /active/i.test(r.status)).length;
    const sel = state.rosterSel && roster.find(r => r.contactId === state.rosterSel);
    main.innerHTML = `<div class="wrap">
      <div class="stats"><div class="stat"><b>${roster.length}</b><span>members in group</span></div><div class="stat"><b>${active}</b><span>active</span></div><div class="stat"><b>${roster.filter(r => r.mfr === 'MFR').length}</b><span>with a current MFR cert</span></div><div class="stat"><b>${roster.filter(r => r.mfr !== 'MFR').length}</b><span>apprentice / no MFR cert on file</span></div></div>
      <div class="bar"><input type="search" placeholder="Search name, email, phone, ID…" value="${esc(q)}"><button class="btn" id="d7-csv">Download CSV</button></div>
      <div class="two"><div class="tbl"><table><thead><tr>${th('Name', 'name', 'roster', 'name')}${th('MFR cert', 'mfr', 'roster', 'name')}${th('Email', 'email', 'roster', 'name')}${th('Phone', 'phone', 'roster', 'name')}${th('Status', 'status', 'roster', 'name')}${th('ID', 'contactId', 'roster', 'name')}</tr></thead><tbody>
        ${rows.map(r => `<tr class="row" data-sel="${esc(r.contactId)}"><td>${esc(r.name)}</td><td>${r.mfr === 'MFR' ? pill('MFR', 'green') + ` <span class="muted">to ${esc(fmtD(r.mfrTo))}</span>` : pill('Apprentice', 'grey')}</td><td><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></td><td><a href="tel:${esc(r.phone)}">${esc(r.phone)}</a></td><td>${statusPill(r.status)}</td><td class="muted">${esc(r.contactId)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="side" id="d7-side">${sel ? '<div class="load">Loading…</div>' : '<span class="muted">Select a member to see their hours and certifications.</span>'}</div></div>
    </div>`;
    const inp = main.querySelector('input[type=search]'); inp.addEventListener('input', () => { state.q = inp.value; renderRoster(); });
    bindSort(main, renderRoster);
    main.querySelectorAll('tr[data-sel]').forEach(tr => tr.addEventListener('click', () => { state.rosterSel = tr.dataset.sel; renderRoster(); }));
    main.querySelector('#d7-csv').addEventListener('click', () => downloadCSV('d0007-roster.csv', ['Name', 'MFR cert', 'MFR cert expiry', 'Email', 'Phone', 'Status', 'Contact ID'], rows.map(r => [r.name, r.mfr, r.mfrTo, r.email, r.phone, r.status, r.contactId])));
    if (sel) memberPanel(sel);
  }
  async function memberPanel(m) {
    const side = main.querySelector('#d7-side'); if (!side) return;
    try {
      const [hrs, certs] = await Promise.all([VMS.hours(''), VMS.certifications().catch(() => [])]);
      const mine = hrs.filter(h => norm(h.name) === norm(m.name));
      const tot = r2(mine.reduce((a, h) => a + h.completed, 0)), pend = r2(mine.reduce((a, h) => a + h.pending, 0));
      const myCerts = certs.filter(c => norm(c.name) === norm(m.name)).sort((a, b) => (toDate(a.expiry)?.getTime() || 0) - (toDate(b.expiry)?.getTime() || 0));
      side.innerHTML = `<h3>${esc(m.name)}</h3><div class="muted">${esc(m.email)} · ${esc(m.phone)} · ${statusPill(m.status)}</div>
        <h4>Last 12 months</h4><div class="stats" style="margin-bottom:6px"><div class="stat"><b>${tot}</b><span>completed hrs</span></div><div class="stat"><b>${pend}</b><span>pending hrs</span></div><div class="stat"><b>${mine.length}</b><span>events</span></div></div>
        ${mine.length ? `<ul class="plain">${mine.sort((a, b) => b.completed - a.completed).slice(0, 12).map(h => `<li><span>${esc(h.event)}</span><span class="n">${h.completed}${h.pending ? ` <span class="muted">(+${h.pending} pending)</span>` : ''}</span></li>`).join('')}</ul>` : '<div class="muted">No participations in the last 12 months.</div>'}
        <h4>SJA certifications</h4>${myCerts.length ? `<ul class="plain">${myCerts.map(c => `<li><span>${esc(c.qualification)}</span><span>${certPill(c.expiry)}</span></li>`).join('')}</ul>` : '<div class="muted">None on file.</div>'}`;
    } catch (e) { side.innerHTML = `<div class="err">${esc(e.message || e)}</div>`; }
  }
  TABS.push({ id: 'roster', label: 'Roster', render: renderRoster });
  D.mfrCertOf = mfrCertOf;
