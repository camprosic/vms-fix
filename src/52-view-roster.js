  // ---- Roster ----
  async function renderRoster() {
    // Certs decide who's MFR vs Apprentice on the Schedule tab; the roster is
    // where you'd expect to see that, so it's a column here too.
    const [roster, certs] = await Promise.all([VMS.roster(), VMS.certifications().catch(() => [])]);
    const members = Store.all('members');
    const withRole = roster.map(r => { const i = Schedule.memberInfo(r.name, { certs, members }); return { ...r, role: i.role, autoRole: i.autoRole, roleSet: i.roleSet, tags: i.tags, unit: i.unit }; });
    const q = state.q;
    const rows = sortRows(withRole.filter(r => matches(q, r.name, r.email, r.phone, r.contactId, r.status, r.role)), 'roster', 'name');
    const active = roster.filter(r => /active/i.test(r.status)).length;
    const sel = state.rosterSel && withRole.find(r => r.contactId === state.rosterSel);
    const roleCell = r => `${esc(r.role)}${r.tags.length ? ` <b class="tag">${esc(r.tags.join('/'))}</b>` : ''}${r.unit ? ` <span class="muted">(${esc(r.unit)})</span>` : ''}${r.roleSet ? ' <span class="muted" title="Set on this roster, not from certifications">·</span>' : ''}`;
    main.innerHTML = `<div class="wrap">
      <div class="stats"><div class="stat"><b>${roster.length}</b><span>members in group</span></div><div class="stat"><b>${active}</b><span>active</span></div><div class="stat"><b>${roster.length - active}</b><span>other status</span></div><div class="stat"><b>${withRole.filter(r => r.role === 'MFR').length}</b><span>MFR</span></div></div>
      <div class="bar"><input type="search" placeholder="Search name, email, phone, ID…" value="${esc(q)}"><button class="btn" id="d7-csv">Download CSV</button></div>
      <div class="two"><div class="tbl"><table><thead><tr>${th('Name', 'name', 'roster', 'name')}${th('Role', 'role', 'roster', 'name')}${th('Email', 'email', 'roster', 'name')}${th('Phone', 'phone', 'roster', 'name')}${th('Status', 'status', 'roster', 'name')}${th('ID', 'contactId', 'roster', 'name')}</tr></thead><tbody>
        ${rows.map(r => `<tr class="row" data-sel="${esc(r.contactId)}"><td>${esc(r.name)}</td><td>${roleCell(r)}</td><td><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></td><td><a href="tel:${esc(r.phone)}">${esc(r.phone)}</a></td><td>${statusPill(r.status)}</td><td class="muted">${esc(r.contactId)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="side" id="d7-side">${sel ? '<div class="load">Loading…</div>' : '<span class="muted">Select a member to see their hours, certifications and schedule tags.</span>'}</div></div>
    </div>`;
    const inp = main.querySelector('input[type=search]'); inp.addEventListener('input', () => { state.q = inp.value; renderRoster(); });
    bindSort(main, renderRoster);
    main.querySelectorAll('tr[data-sel]').forEach(tr => tr.addEventListener('click', () => { state.rosterSel = tr.dataset.sel; renderRoster(); }));
    main.querySelector('#d7-csv').addEventListener('click', () => downloadCSV('d0007-roster.csv', ['Name', 'Role', 'Tags', 'Unit', 'Email', 'Phone', 'Status', 'Contact ID'], rows.map(r => [r.name, r.role, r.tags.join('/'), r.unit, r.email, r.phone, r.status, r.contactId])));
    if (sel) memberPanel(sel);
  }
  // The bits of a member the schedule needs and VMS has no field for: MFR or
  // Apprentice (when the cert feed is wrong or missing), Command / Driver /
  // Senior, and a home unit for people borrowed from Burlington et al.
  function tagForm(m) {
    const cur = Store.get('members', norm(m.name)) || {};
    const role = cur.role === 'MFR' || cur.role === 'Apprentice' ? cur.role : '';
    const tags = Array.isArray(cur.tags) ? cur.tags : [];
    return `<h4>Schedule tags</h4>
      <form id="d7-tags" class="tagform">
        <label>Role <select name="role"><option value="" ${role ? '' : 'selected'}>Auto (${esc(m.autoRole || '')})</option><option value="MFR" ${role === 'MFR' ? 'selected' : ''}>MFR</option><option value="Apprentice" ${role === 'Apprentice' ? 'selected' : ''}>Apprentice</option></select></label>
        <span class="tagset">${Schedule.TAGS.map(t => `<label><input type="checkbox" name="tag" value="${t}" ${tags.includes(t) ? 'checked' : ''}> ${t}</label>`).join('')}</span>
        <label>Unit <input type="text" name="unit" value="${esc(cur.unit || '')}" placeholder="e.g. Burl" size="8"></label>
      </form>
      <div class="muted" style="font-size:12px">Auto role is ${esc(m.autoRole || '')}${m.autoRole === 'MFR' ? ' (current Medical First Responder cert on file)' : ' (no current Medical First Responder cert in the feed)'}. C = Command, D = Driver, Sr = Senior. Saved in this browser; shows on the Schedule tab as "${esc(m.name)} C/D (Burl)".</div>`;
  }
  function bindTagForm(m) {
    const f = main.querySelector('#d7-tags'); if (!f) return;
    f.addEventListener('submit', e => e.preventDefault());
    f.addEventListener('change', () => {
      // (form.role is the ARIA attribute, not the select - hence querySelector)
      const role = f.querySelector('select[name=role]').value, tags = [...f.querySelectorAll('input[name=tag]:checked')].map(i => i.value), unit = f.querySelector('input[name=unit]').value.trim();
      Store.patch('members', norm(m.name), { role, tags, unit });
      renderRoster();
    });
  }
  async function memberPanel(m) {
    const side = main.querySelector('#d7-side'); if (!side) return;
    try {
      const [hrs, certs] = await Promise.all([VMS.hours(''), VMS.certifications().catch(() => [])]);
      const mine = hrs.filter(h => norm(h.name) === norm(m.name));
      const tot = r2(mine.reduce((a, h) => a + h.completed, 0)), pend = r2(mine.reduce((a, h) => a + h.pending, 0));
      const myCerts = certs.filter(c => norm(c.name) === norm(m.name)).sort((a, b) => (toDate(a.expiry)?.getTime() || 0) - (toDate(b.expiry)?.getTime() || 0));
      side.innerHTML = `<h3>${esc(m.name)}</h3><div class="muted">${esc(m.email)} · ${esc(m.phone)} · ${statusPill(m.status)}</div>
        ${tagForm(m)}
        <h4>Last 12 months</h4><div class="stats" style="margin-bottom:6px"><div class="stat"><b>${tot}</b><span>completed hrs</span></div><div class="stat"><b>${pend}</b><span>pending hrs</span></div><div class="stat"><b>${mine.length}</b><span>events</span></div></div>
        ${mine.length ? `<ul class="plain">${mine.sort((a, b) => b.completed - a.completed).slice(0, 12).map(h => `<li><span>${esc(h.event)}</span><span class="n">${h.completed}${h.pending ? ` <span class="muted">(+${h.pending} pending)</span>` : ''}</span></li>`).join('')}</ul>` : '<div class="muted">No participations in the last 12 months.</div>'}
        <h4>SJA certifications</h4>${myCerts.length ? `<ul class="plain">${myCerts.map(c => `<li><span>${esc(c.qualification)}</span><span>${certPill(c.expiry)}</span></li>`).join('')}</ul>` : '<div class="muted">None on file.</div>'}`;
      bindTagForm(m);
    } catch (e) { side.innerHTML = `<div class="err">${esc(e.message || e)}</div>`; }
  }
  CSS_PARTS.push(`
#d0007-root .tagform{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px;margin-bottom:6px}
#d0007-root .tagform select,#d0007-root .tagform input[type=text]{font:inherit;font-size:13px;border:1px solid #cfd8d0;border-radius:6px;padding:4px 6px;background:#fff}
#d0007-root .tagform .tagset{display:inline-flex;gap:8px}
#d0007-root .tagform .tagset label{white-space:nowrap}
`);
  TABS.push({ id: 'roster', label: 'Roster', render: renderRoster });
