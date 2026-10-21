  // ---- Schedule ----
  // The spreadsheet, as far as VMS can fill it in. Month at a time. Copy it,
  // download it, print it. The rows paint as soon as the events are in and the
  // MFR / Apprentice columns tidy themselves up as the booking forms come back.
  const SC = { rows: null, loading: false, progress: '', error: null, token: 0, flash: '' };
  if (!state.schedY) { const t = Schedule.today(); state.schedY = t.year; state.schedM = t.month; }

  async function renderSchedule() {
    const token = ++SC.token;
    SC.rows = null; SC.error = null; SC.loading = true; SC.progress = 'Reading events…';
    paintSchedule();
    const y = state.schedY, m = state.schedM;
    try {
      const rows = await Schedule.monthRows(y, m, { onProgress: p => { if (token !== SC.token) return; SC.progress = p.phase === 'events' ? (p.total ? `Reading events… ${p.done} of ${p.total}` : 'Reading events…') : ''; schedProgress(); } });
      if (token !== SC.token || !stillCurrent('schedule')) return;
      SC.rows = rows; SC.loading = false; SC.progress = '';
      paintSchedule();
      // second pass: the booked shift for everyone, straight from VMS
      await Schedule.resolveRoles(rows, {
        onProgress: p => { if (token !== SC.token) return; SC.progress = p.total ? `Checking who booked which shift with VMS… ${p.done} of ${p.total}` : ''; schedProgress(); },
        onRow: r => { if (token === SC.token && stillCurrent('schedule')) schedRowDom(r); },
      });
      if (token !== SC.token || !stillCurrent('schedule')) return;
      SC.progress = ''; schedProgress(); schedToolbar();
    } catch (e) {
      if (token !== SC.token || !stillCurrent('schedule')) return;
      SC.error = e.message || String(e); SC.loading = false; paintSchedule();
    }
  }
  function schedProgress() { const n = main && main.querySelector('#sc-progress'); if (n) { n.textContent = SC.progress; n.hidden = !SC.progress; } }

  // --- painting
  const scLabel = () => Schedule.monthLabel(state.schedY, state.schedM);
  function paintSchedule() {
    if (!stillCurrent('schedule') || !main) return;
    const rows = SC.rows || [];
    const q = state.q || '';
    const shown = rows.filter(r => matches(q, r.event.title, r.event.locationName, r.people.map(p => p.name).join(' '), r.contact && r.contact.name));
    main.innerHTML = `<div class="wrap sc-wrap">
      <div class="bar">
        <div class="seg"><button data-nav="-1" title="Previous month">‹</button><button data-nav="0">This month</button><button data-nav="1" title="Next month">›</button></div>
        <h2 class="sc-h">${esc(scLabel())}</h2>
        <span class="sp"></span>
        <input type="search" placeholder="Filter by event, place or name…" value="${esc(q)}">
      </div>
      <div class="bar sc-tools">
        <button class="btn" id="sc-copy" ${rows.length ? '' : 'disabled'} title="Copies the month as rows you can paste straight into the sheet">Copy month for spreadsheet</button>
        <button class="btn" id="sc-xlsx" ${rows.length ? '' : 'disabled'}>Download .xlsx</button>
        <button class="btn" id="sc-print" ${rows.length ? '' : 'disabled'}>Print</button>
        <span class="sc-flash" id="sc-flash">${esc(SC.flash)}</span>
        <span class="sp"></span>
        <span class="muted sc-progress" id="sc-progress" ${SC.progress ? '' : 'hidden'}>${esc(SC.progress)}</span>
      </div>
      ${SC.error ? `<div class="err"><b>Couldn't build the schedule.</b> ${esc(SC.error)}</div>` : ''}
      ${SC.loading && !SC.error ? `<div class="load">${esc(SC.progress || 'Loading…')}</div>` : ''}
      ${!SC.loading && !SC.error && !shown.length ? `<div class="card muted">${rows.length ? 'Nothing matches that filter.' : `No D0007 events in ${esc(scLabel())}.`}</div>` : ''}
      ${shown.length ? `<div class="tbl sc-tbl"><table class="sc-table"><thead><tr>
          <th class="sc-ev">Event</th><th>Date</th><th>Meet @ St.John</th><th>Approx. End</th><th>Shifts</th><th>Location</th><th>On-site contact</th><th>Medical First Responders</th><th>Apprentice</th><th>Quals</th>
        </tr></thead><tbody>${schedBody(shown)}</tbody></table></div>
        <p class="muted sc-foot">Meet @ St.John is the shift start in VMS. Copy / download put the sheet's 12 columns in order and leave Meet @ Event, Event Notes (except partial-shift lines), Equipment and Vehicle blank - VMS has nothing for them. Names marked * have a shift that differs from the main one; the note says how. No-shows and waitlisted people are shown here but kept out of the export.</p>` : ''}
    </div>`;
    bindSchedule();
  }
  function schedBody(rows) {
    let prev = null, html = '';
    for (const r of rows) {
      if (prev && prev !== r.date) html += '<tr class="sc-gap"><td colspan="10"></td></tr>';
      html += schedRowHTML(r); prev = r.date;
    }
    return html;
  }
  const scTime = d => d ? Schedule.hm(d) : '';
  function schedRowHTML(r) {
    return `<tr class="sc-row" data-key="${esc(r.key)}">${schedCells(r)}</tr>`;
  }
  function schedCells(r) {
    const ev = r.event, st = r.staffing;
    const person = p => `<div class="sc-p${isNoShowOrWait(p.status) ? ' sc-out' : ''}"><span>${esc(p.name)}${p.partial ? '<b>' + esc(p.partial.nameMark) + '</b>' : ''}</span>${p.partial ? `<span class="muted"> · ${esc(p.partial.text)}</span>` : ''}${isNoShowOrWait(p.status) ? ` ${statusPill(p.status)}` : ''}${p.roleSource === 'cert' ? ' <span class="sc-cert" title="From certifications - VMS hasn\'t confirmed the booked shift yet">cert</span>' : ''}</div>`;
    // each shift definition of this kind as its own block: "MFR day 3 · 16:00–23:00 · 3/10" then the names under it
    const names = kind => {
      const gs = (r.groups || []).filter(g => g.kind === kind);
      if (!gs.length) return '<span class="muted">—</span>';
      return gs.map(g => `<div class="sc-grp"><div class="sc-grph"><b>${esc(g.name)}</b>${g.def ? `<span class="muted"> ${esc(scTime(g.def.start))}–${esc(scTime(g.def.end))}${g.def.max !== null ? ` · ${g.def.booked}/${g.def.max}` : ''}</span>` : ''}</div>${g.people.map(person).join('') || '<div class="muted">nobody yet</div>'}</div>`).join('');
    };
    const defs = r.defs.length ? r.defs.map(d => `<div class="sc-def"><b>${esc(d.name)}</b> ${esc(scTime(d.start))}–${esc(scTime(d.end))}${d.max !== null ? ` · <span class="n">${d.booked}/${d.max}</span>` : ` · ${d.booked} booked`}${d.needed > 0 ? ` ${pill(`${d.needed} needed`, 'red')}` : d.needed !== null && d.needed < 0 ? ` ${pill(`over by ${-d.needed}`, 'amber')}` : ''}</div>`).join('') : '<span class="muted">No shift definitions on the public page</span>';
    const addr = ev.address ? [ev.address.street, [ev.address.city, ev.address.province].filter(Boolean).join(', ') + (ev.address.postal ? `  ${ev.address.postal}` : '')].filter(x => x && x.trim()) : [];
    const contact = r.contact ? `<div><b>${esc(r.contact.name || '')}</b></div>${r.contact.phone ? `<div><a href="tel:${esc(r.contact.phone)}">${esc(r.contact.phone)}</a></div>` : ''}${r.contact.email ? `<div><a href="mailto:${esc(r.contact.email)}">${esc(r.contact.email)}</a></div>` : ''}${r.organizer && r.organizer.organization ? `<div class="muted">${esc(r.organizer.organization)}</div>` : ''}${r.request && r.request.onSite ? `<div class="muted sc-onsite" title="From the event request: what the organizer says is on site">${esc(onSiteText(r.request.onSite))}</div>` : ''}`
      : '<span class="muted" title="The organizer contact lives on the event request. VMS only shows requests to a group lead while they are waiting for approval; once the event is approved it hides them.">Not shown by VMS once the event is approved</span>';
    const staff = st && st.known ? `<div class="sc-staff">${st.level === 'ok' ? pill('Covered', 'green') : ''}${st.problems.map(p => pill(p, st.level === 'short' ? 'red' : 'amber')).join(' ')}<span class="muted"> ${st.mfr.booked} MFR${st.mfr.booked === 1 ? '' : 's'} · ${st.app.booked} apprentice${st.app.booked === 1 ? '' : 's'}</span></div>` : '';
    return `
      <td class="sc-ev"><div class="sc-title">${esc(ev.title)}</div><div class="muted">${esc(ev.program || '')} ${statusPill(ev.status)}</div>${ev.description ? `<div class="muted sc-desc">${esc(ev.description)}</div>` : ''}${staff}<div class="sc-links"><a href="${esc(ev.link)}" target="_blank" rel="noopener">Open in VMS ↗</a>${ev.publicLink ? ` · <a href="${esc(ev.publicLink)}" target="_blank" rel="noopener">Public page ↗</a>` : ''}</div></td>
      <td class="sc-date">${esc(r.dateLabel)}</td>
      <td class="n">${esc(r.meetSJ)}</td>
      <td class="n">${esc(r.approxEnd)}</td>
      <td>${defs}</td>
      <td><div><b>${esc(ev.locationName || '')}</b></div>${addr.map(a => `<div>${esc(a)}</div>`).join('')}</td>
      <td>${contact}</td>
      <td>${names('MFR')}${r.noShift.length ? `<div class="muted sc-noshift">Signed up, no shift: ${esc(r.noShift.join(', '))}</div>` : ''}</td>
      <td>${names('Apprentice')}</td>
      <td>${r.quals.length ? r.quals.map(q => pill(q, 'grey')).join(' ') : '<span class="muted">—</span>'}</td>`;
  }
  const isNoShowOrWait = s => /no.?show|wait ?list/i.test(s || '');
  const onSiteText = o => { const yes = Object.entries({ firstAidRoom: 'first aid room/tent', volunteerArea: 'volunteer area', water: 'water', food: 'food for volunteers', parking: 'parking', bathrooms: 'bathrooms', shade: 'shade', power: 'power', cellReception: 'cell reception', otherAgencies: 'EMS/police on site' }).filter(([k]) => o[k]).map(([, v]) => v); return yes.length ? 'On site: ' + yes.join(', ') : ''; };
  function schedRowDom(r) {
    const tr = main && main.querySelector(`tr.sc-row[data-key="${CSS.escape ? CSS.escape(r.key) : r.key}"]`);
    if (tr) tr.innerHTML = schedCells(r);
  }

  // --- toolbar
  function schedToolbar() { ['sc-copy', 'sc-xlsx', 'sc-print'].forEach(id => { const b = main.querySelector('#' + id); if (b) b.disabled = !(SC.rows && SC.rows.length); }); }
  function schedFlash(text) { SC.flash = text; const n = main.querySelector('#sc-flash'); if (n) n.textContent = text; setTimeout(() => { if (SC.flash === text) { SC.flash = ''; const m = main.querySelector('#sc-flash'); if (m) m.textContent = ''; } }, 4000); }
  async function copySchedule() {
    const tsv = Schedule.toTSV(SC.rows);
    let ok = false;
    try { await navigator.clipboard.writeText(tsv); ok = true; } catch (e) { /* no clipboard permission - fall through */ }
    if (!ok) { const ta = el('textarea', { style: 'position:fixed;left:-9999px;top:0' }); ta.value = tsv; document.body.appendChild(ta); ta.select(); try { ok = document.execCommand('copy'); } catch (e) { /* nothing */ } ta.remove(); }
    schedFlash(ok ? `Copied ${SC.rows.length} row${SC.rows.length === 1 ? '' : 's'} - paste into the sheet` : 'Copy failed - try Download .xlsx instead');
  }
  function downloadXLSX() {
    const bytes = Schedule.toXLSX(SC.rows, { sheetName: scLabel().split(' ')[0] });
    const a = el('a', { href: URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })), download: `Event Schedule ${scLabel()}.xlsx` });
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function bindSchedule() {
    main.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => {
      const n = +b.dataset.nav;
      if (n === 0) { const t = Schedule.today(); state.schedY = t.year; state.schedM = t.month; }
      else { let m = state.schedM + n, y = state.schedY; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; } state.schedM = m; state.schedY = y; }
      render();
    }));
    const inp = main.querySelector('input[type=search]'); if (inp) inp.addEventListener('input', () => { state.q = inp.value; const tb = main.querySelector('.sc-table tbody'); const rows = (SC.rows || []).filter(r => matches(state.q, r.event.title, r.event.locationName, r.people.map(p => p.name).join(' '), r.contact && r.contact.name)); if (tb) tb.innerHTML = schedBody(rows); else paintSchedule(); });
    main.querySelector('#sc-copy')?.addEventListener('click', copySchedule);
    main.querySelector('#sc-xlsx')?.addEventListener('click', downloadXLSX);
    main.querySelector('#sc-print')?.addEventListener('click', () => { document.documentElement.classList.add('d7-print'); const done = () => { document.documentElement.classList.remove('d7-print'); window.removeEventListener('afterprint', done); }; window.addEventListener('afterprint', done); setTimeout(() => window.print(), 50); });
  }

  CSS_PARTS.push(`
#d0007-root .sc-h{font-size:17px;margin:0 6px}
#d0007-root .sc-tools{margin-top:-4px}
#d0007-root .sc-flash{font-size:12.5px;color:#1f5a2c;min-height:18px}
#d0007-root .sc-progress{font-size:12.5px}
#d0007-root .sc-tbl{max-height:none}
#d0007-root .sc-table{min-width:1500px;table-layout:fixed}
#d0007-root .sc-table th,#d0007-root .sc-table td{font-size:12.5px;vertical-align:top;white-space:normal}
#d0007-root .sc-table th.sc-ev,#d0007-root .sc-table td.sc-ev{position:sticky;left:0;background:#fff;z-index:2;width:260px;box-shadow:2px 0 0 #e7ebe7}
#d0007-root .sc-table th.sc-ev{z-index:3;background:#f7f9f7}
#d0007-root .sc-table th:nth-child(2),#d0007-root .sc-table td:nth-child(2){width:86px}
#d0007-root .sc-table th:nth-child(3),#d0007-root .sc-table th:nth-child(4){width:72px}
#d0007-root .sc-table th:nth-child(5){width:230px}
#d0007-root .sc-table th:nth-child(6){width:200px}
#d0007-root .sc-table th:nth-child(7){width:200px}
#d0007-root .sc-table th:nth-child(8),#d0007-root .sc-table th:nth-child(9){width:190px}
#d0007-root .sc-table th:nth-child(10){width:120px}
#d0007-root .sc-title{font-weight:600;font-size:14px}
#d0007-root .sc-desc{font-size:12px;margin-top:2px}
#d0007-root .sc-links{font-size:12px;margin-top:4px}
#d0007-root .sc-staff{margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;align-items:center}
#d0007-root .sc-def{white-space:nowrap}
#d0007-root .sc-grp{margin-bottom:8px}
#d0007-root .sc-grp:last-child{margin-bottom:0}
#d0007-root .sc-grph{font-size:12px;border-bottom:1px solid #e7ebe7;margin-bottom:3px;white-space:nowrap}
#d0007-root .sc-p{line-height:1.5}
#d0007-root .sc-p b{color:#9a2b1d;margin-left:1px}
#d0007-root .sc-out{opacity:.6}
#d0007-root .sc-cert{font-size:10px;color:#8a5a00;background:#fdeccd;border-radius:3px;padding:0 4px;vertical-align:middle}
#d0007-root .sc-noshift{font-size:11.5px;margin-top:6px}
#d0007-root .sc-onsite{font-size:11.5px;margin-top:4px}
#d0007-root .sc-gap td{height:6px;background:#eef1ee;padding:0;border:0}
#d0007-root .sc-foot{font-size:12px;margin-top:8px}
@media print{
  html.d7-print body > :not(#d0007-root){display:none!important}
  html.d7-print #d0007-root{position:static;height:auto;overflow:visible;display:block;background:#fff;font-size:10px}
  html.d7-print #d0007-root header,html.d7-print #d0007-root nav,html.d7-print #d0007-root footer,html.d7-print #d0007-root .seg,html.d7-print #d0007-root .btn,html.d7-print #d0007-root input,html.d7-print #d0007-root .sc-flash,html.d7-print #d0007-root .sc-foot,html.d7-print #d0007-root .sc-links,html.d7-print #d0007-root .sc-progress{display:none!important}
  html.d7-print #d0007-root main{overflow:visible;padding:0}
  html.d7-print #d0007-root .sc-h:before{content:"Event Schedule - "}
  html.d7-print #d0007-root .sc-tbl{max-height:none;overflow:visible;border:0;border-radius:0}
  html.d7-print #d0007-root .sc-table{min-width:0;width:100%;table-layout:auto}
  html.d7-print #d0007-root .sc-table th,html.d7-print #d0007-root .sc-table td{position:static;font-size:9px;padding:3px 4px;border:1px solid #cfd8d0;-webkit-print-color-adjust:exact;print-color-adjust:exact;box-shadow:none}
  html.d7-print #d0007-root .sc-table thead{display:table-header-group}
  html.d7-print #d0007-root .sc-table tr{break-inside:avoid;page-break-inside:avoid}
  @page{size:landscape;margin:10mm}
}
`);
  TABS.push({ id: 'schedule', label: 'Schedule', render: renderSchedule });
