  // ---- Schedule ----
  // The monthly Event Schedule, on screen. Same twelve columns as the sheet,
  // one row per event day, VMS filling in what it knows and the rest typed
  // straight into the cell. "Copy month for spreadsheet" is for anyone who
  // still wants it in Excel.
  // Month lives on state (so it survives a Refresh); the rest is ours.
  const sched = { rows: [], req: 0, flashTimer: null };
  const SCHED_MULTI = new Set(['notes', 'requirement', 'equipment', 'vehicle']);
  const SCHED_LABEL = { meetSJ: 'Meet @ St.John', meetEvent: 'Meet @ Event', approxEnd: 'Approx. End', coordinator: 'On-Site Coordinator', requirement: 'Requirement (e.g. 1 Command / 1 Driver / 3 MFR)', notes: 'Notes', equipment: 'Equipment, one per line', vehicle: 'Vehicle, one per line' };
  const SCHED_PLACEHOLDER = { requirement: 'Requirement', notes: 'Notes' };
  // The sheet's fills are full-strength; on screen that's unreadable, so mix
  // them 80% towards white and keep the real hex for the swatch and the export.
  const tint = hex => { const n = parseInt(hex.slice(1), 16); const mix = v => Math.round(v * 0.2 + 255 * 0.8); return `rgb(${mix(n >> 16 & 255)},${mix(n >> 8 & 255)},${mix(n & 255)})`; };
  const vmsEventLink = id => `/en-US/group-lead/event-summary/?eventid=${encodeURIComponent(id)}&groupid=${GROUP_ID}`;

  async function renderSchedule() {
    if (!state.schedY) { const t = Schedule.today(); state.schedY = t.year; state.schedM = t.month; }
    scheduleFrame();
    const req = ++sched.req;
    const rows = await Schedule.monthRows(state.schedY, state.schedM);
    if (req !== sched.req) return;   // user moved on to another month while this one loaded
    sched.rows = rows;
    paintSchedule();
  }
  // Header bar plus an empty table slot. Separate from the paint so it can be
  // put back if another tab's slow render lands on top of ours.
  function scheduleFrame() {
    main.innerHTML = `<div class="wrap wide">
      <div class="bar sched-bar">
        <div class="seg"><button data-nav="-1" title="Previous month">‹</button><button data-nav="0">This month</button><button data-nav="1" title="Next month">›</button></div>
        <h2 class="sched-h">${esc(Schedule.monthLabel(state.schedY, state.schedM))}</h2>
        <span class="sp"></span>
        <button class="btn" id="d7-copy" disabled title="Copies the month as tab-separated text, ready to paste over the sheet">Copy month for spreadsheet</button>
        <button class="btn" id="d7-xlsx" disabled>Download .xlsx</button>
        <button class="btn" id="d7-print" disabled>Print</button>
        <span class="sched-flash" id="d7-flash" aria-live="polite"></span>
      </div>
      <div id="d7-sched"><div class="load">Loading events…</div></div>
      <p class="muted sched-foot">Event, date, location, meet-at-event, approx. end and the names come from VMS (shifts on the event). Everything else is typed here and kept in this browser - see the Data tab to move it between people. Click a cell to edit; Enter saves, Esc cancels; clearing Meet @ Event or Approx. End goes back to the VMS value. Colours: ${Schedule.COLOURS.map(c => `<span class="sw" style="background:${c.hex}"></span> ${esc(c.label)}`).join(' · ')}</p>
    </div>`;
    main.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => {
      const n = +b.dataset.nav;
      if (n === 0) { const t = Schedule.today(); state.schedY = t.year; state.schedM = t.month; }
      else { state.schedM += n; if (state.schedM < 1) { state.schedM = 12; state.schedY--; } if (state.schedM > 12) { state.schedM = 1; state.schedY++; } }
      render();
    }));
    main.querySelector('#d7-copy').addEventListener('click', copySchedule);
    main.querySelector('#d7-xlsx').addEventListener('click', downloadSchedule);
    main.querySelector('#d7-print').addEventListener('click', printSchedule);
  }

  function paintSchedule() {
    if (state.tab !== 'schedule') return;
    if (!main.querySelector('#d7-sched')) scheduleFrame();   // something else painted main while we were fetching
    const box = main.querySelector('#d7-sched');
    const rows = sched.rows;
    main.querySelectorAll('#d7-copy,#d7-xlsx,#d7-print').forEach(b => { b.disabled = !rows.length; });
    if (!rows.length) { box.innerHTML = `<div class="card muted">No events with a day in ${esc(Schedule.monthLabel(state.schedY, state.schedM))}.</div>`; return; }
    let body = '', prev = null;
    rows.forEach(r => {
      if (prev && prev !== r.date) body += `<tr class="sched-gap"><td colspan="${Schedule.COLUMNS.length}"></td></tr>`;
      body += `<tr class="sched-row" data-key="${esc(r.key)}" style="${rowStyle(r)}">${rowHTML(r)}</tr>`; prev = r.date;
    });
    box.innerHTML = `<div class="tbl sched-tbl"><table class="sched-table"><thead><tr>${Schedule.COLUMNS.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
    box.querySelectorAll('tr[data-key]').forEach(bindRow);
  }
  const rowStyle = r => r.colour ? `--tint:${tint(r.colour)}` : '';
  function rowHTML(r) {
    const ed = field => {
      const v = r[field] || '', edited = r.edited && r.edited[field];
      const tip = `${SCHED_LABEL[field]} - click to edit${edited ? `. VMS says ${r.derived[field] || 'nothing'}; clear the cell to use that` : ''}`;
      return `<div class="ed" data-field="${field}" title="${esc(tip)}" tabindex="0">${v ? esc(v).replace(/\n/g, '<br>') : `<span class="muted">${esc(SCHED_PLACEHOLDER[field] || '—')}</span>`}${edited ? '<i class="edited" title="Edited here; VMS has a different value"></i>' : ''}</div>`;
    };
    const person = p => `<div class="nm">${esc(p.name)}${p.tags.length ? ` <b class="tag">${esc(p.tags.join('/'))}</b>` : ''}${p.unit ? ` <span class="muted">(${esc(p.unit)})</span>` : ''}${p.partial ? `<b class="star" title="${esc(p.partial.start + ' to ' + p.partial.end)}">${esc(p.partial.mark)}</b>` : ''}${/no.?show/i.test(p.status) ? ' <span class="pill red">no show</span>' : ''}</div>`;
    const names = role => {
      const ps = r.people.filter(p => p.role === role).map(person);
      const extra = [...r.waitlisted.filter(p => p.role === role).map(p => `<div class="nm muted">${esc(p.name)} <span class="why">(waitlist)</span></div>`), ...r.signedUpNoShift.filter(p => p.role === role).map(p => `<div class="nm muted">${esc(p.name)} <span class="why">(signed up, no shift)</span></div>`)];
      return ps.join('') + (ps.length || extra.length ? '' : '<span class="muted">—</span>') + extra.join('');
    };
    const swatches = `<span class="sw-row">${[{ hex: '', label: 'No colour' }, ...Schedule.COLOURS].map(c => `<button type="button" class="sw ${r.colour === c.hex ? 'on' : ''}" data-colour="${c.hex}" title="${esc(c.label)}" style="background:${c.hex || '#fff'}"></button>`).join('')}</span>`;
    return `<td class="c-event"><div class="ev-t">${esc(r.title)}</div><div class="ev-m"><a href="${esc(vmsEventLink(r.eventId))}" target="_blank" rel="noopener">Open in VMS ↗</a>${r.error ? ` <span class="pill red" title="${esc(r.error)}">detail failed</span>` : ''}${r.shiftCount ? '' : ' <span class="muted">no shifts yet</span>'}</div>${swatches}</td>
      <td class="c-date"><b>${esc(r.dateLabel)}</b>${r.startMismatch ? `<div class="muted why">VMS start ${esc(fmtD(r.eventStart))}</div>` : ''}</td>
      <td>${ed('meetSJ')}</td><td>${ed('meetEvent')}</td><td>${ed('approxEnd')}</td>
      <td>${esc(r.location) || '<span class="muted">—</span>'}</td>
      <td>${ed('coordinator')}</td>
      <td class="c-notes">${ed('requirement')}${r.derived.notes.length ? `<div class="auto" title="From the shifts in VMS">${r.derived.notes.map(esc).join('<br>')}</div>` : ''}${ed('notes')}</td>
      <td class="c-names">${names('MFR')}</td><td class="c-names">${names('Apprentice')}</td>
      <td>${ed('equipment')}</td><td>${ed('vehicle')}</td>`;
  }
  function bindRow(tr) {
    const row = sched.rows.find(r => r.key === tr.dataset.key); if (!row) return;
    tr.querySelectorAll('.ed[data-field]').forEach(d => {
      d.addEventListener('click', () => startEdit(tr, row, d.dataset.field));
      d.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === d) { e.preventDefault(); startEdit(tr, row, d.dataset.field); } });
    });
    tr.querySelectorAll('.sw[data-colour]').forEach(b => b.addEventListener('click', () => saveField(tr, row, 'colour', b.dataset.colour)));
  }
  function saveField(tr, row, field, value) {
    Store.patch('schedule', row.key, { [field]: value });
    Object.assign(row, Schedule.withOverrides(row));
    tr.style.cssText = rowStyle(row); tr.innerHTML = rowHTML(row); bindRow(tr);
  }
  function startEdit(tr, row, field) {
    const box = tr.querySelector(`.ed[data-field="${field}"]`); if (!box || box.querySelector('input,textarea')) return;
    const multi = SCHED_MULTI.has(field), cur = row[field] || '';
    box.innerHTML = multi ? `<textarea rows="${Math.min(6, Math.max(2, cur.split('\n').length + 1))}" placeholder="${esc(SCHED_LABEL[field])}">${esc(cur)}</textarea>` : `<input type="text" value="${esc(cur)}" placeholder="${esc(field === 'meetSJ' || field === 'meetEvent' || field === 'approxEnd' ? 'HH:MM' : SCHED_LABEL[field])}">`;
    const inp = box.firstElementChild; inp.focus(); if (!multi) inp.select();
    let done = false;
    const finish = save => {
      if (done) return; done = true;
      if (save && inp.value !== cur) saveField(tr, row, field, inp.value);
      else { tr.innerHTML = rowHTML(row); bindRow(tr); }
    };
    inp.addEventListener('blur', () => finish(true));
    inp.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      else if (e.key === 'Enter' && (!multi || e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); }
    });
  }
  function flash(msg) {
    const f = main.querySelector('#d7-flash'); if (!f) return;
    f.textContent = msg; clearTimeout(sched.flashTimer); sched.flashTimer = setTimeout(() => { f.textContent = ''; }, 3000);
  }
  async function copySchedule() {
    const tsv = Schedule.toTSV(sched.rows);
    let ok = false;
    try { await navigator.clipboard.writeText(tsv); ok = true; } catch (e) { /* no clipboard permission - try the old way */ }
    if (!ok) {
      const ta = el('textarea', { style: 'position:fixed;left:-9999px;top:0', 'aria-hidden': 'true' }); ta.value = tsv; root.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
    }
    flash(ok ? `Copied ${sched.rows.length} rows. Paste into the sheet with the Event column selected.` : 'Copy failed - the browser blocked clipboard access.');
  }
  function downloadSchedule() {
    const name = `Event Schedule ${Schedule.monthLabel(state.schedY, state.schedM)}.xlsx`;
    const bytes = Schedule.toXLSX(sched.rows, { sheetName: Schedule.monthName(state.schedM) });
    const a = el('a', { href: URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })), download: name });
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    flash(`Saved ${name}`);
  }
  function printSchedule() {
    // Landscape only while we're the ones printing; the portal's own pages can
    // keep whatever orientation they had.
    document.body.classList.add('d7-print');
    const page = el('style', { id: 'd7-print-page' }, '@page{size:landscape;margin:10mm}'); document.head.appendChild(page);
    const off = () => { document.body.classList.remove('d7-print'); page.remove(); window.removeEventListener('afterprint', off); };
    window.addEventListener('afterprint', off);
    window.print();
    setTimeout(off, 1000);   // Safari doesn't always fire afterprint
  }

  CSS_PARTS.push(`
#d0007-root .wrap.wide{max-width:none}
#d0007-root .sched-h{font-size:18px;margin:0 6px;font-weight:600;color:#1f4d2b;white-space:nowrap}
#d0007-root .sched-flash{font-size:12.5px;color:#1f5a2c;flex-basis:100%}
#d0007-root .sched-flash:empty{display:none}
#d0007-root .sched-tbl{max-height:75vh}
#d0007-root .sched-table{min-width:1400px;table-layout:fixed}
#d0007-root .sched-table th{cursor:default;z-index:2;white-space:normal;vertical-align:bottom}
#d0007-root .sched-table th:first-child,#d0007-root .sched-table td:first-child{position:sticky;left:0}
#d0007-root .sched-table th:first-child{z-index:3}
#d0007-root .sched-table td:first-child{z-index:1;border-right:1px solid #dfe5e0}
#d0007-root .sched-table td{background:var(--tint,#fff);vertical-align:top;font-size:12.5px}
#d0007-root .sched-table th:nth-child(1){width:200px}
#d0007-root .sched-table th:nth-child(2){width:88px}
#d0007-root .sched-table th:nth-child(3),#d0007-root .sched-table th:nth-child(4),#d0007-root .sched-table th:nth-child(5){width:72px}
#d0007-root .sched-table th:nth-child(6){width:140px}
#d0007-root .sched-table th:nth-child(7){width:120px}
#d0007-root .sched-table th:nth-child(8){width:200px}
#d0007-root .sched-table th:nth-child(9){width:170px}
#d0007-root .sched-table th:nth-child(10){width:150px}
#d0007-root .sched-table th:nth-child(11),#d0007-root .sched-table th:nth-child(12){width:80px}
#d0007-root .sched-gap td{height:7px;padding:0;background:#f3f5f2;border-bottom:0}
#d0007-root .ev-t{font-weight:600}
#d0007-root .ev-m{font-size:11.5px;margin-top:2px}
#d0007-root .why{font-size:11px}
#d0007-root .sw-row{display:inline-flex;gap:3px;margin-top:6px}
#d0007-root .sw{display:inline-block;width:14px;height:14px;border:1px solid #b9c2ba;border-radius:3px;padding:0;cursor:pointer;vertical-align:middle}
#d0007-root .sw.on{outline:2px solid #1f4d2b;outline-offset:1px}
#d0007-root .ed{min-height:20px;border-radius:4px;padding:1px 3px;margin:-1px -3px;cursor:text;white-space:pre-wrap;word-break:break-word;position:relative}
#d0007-root .ed:hover,#d0007-root .ed:focus{background:rgba(31,77,43,.07);outline:none}
#d0007-root .ed input,#d0007-root .ed textarea{width:100%;font:inherit;border:1px solid #1f4d2b;border-radius:4px;padding:2px 4px;background:#fff;resize:vertical}
#d0007-root .ed .edited{display:inline-block;width:6px;height:6px;border-radius:50%;background:#b8860b;margin-left:4px;vertical-align:middle}
#d0007-root .c-notes .ed+.ed,#d0007-root .c-notes .auto{margin-top:4px}
#d0007-root .c-notes .auto{color:#3a4a3d;font-style:italic;white-space:pre-wrap}
#d0007-root .nm{margin-bottom:1px}
#d0007-root .nm .tag{color:#1f4d2b}
#d0007-root .nm .star{color:#b23a2a;margin-left:1px}
#d0007-root .sched-foot{font-size:12px;margin-top:10px}
#d0007-root .sched-foot .sw{width:11px;height:11px;cursor:default}
${['body.d7-print', 'body:has(> #d0007-root:not([style*="none"]))'].map(scope => `
@media print{
  ${scope} > :not(#d0007-root){display:none!important}
  ${scope} #d0007-root{position:static;height:auto;overflow:visible;display:block;background:#fff;font-size:11px}
  ${scope} #d0007-root header,${scope} #d0007-root nav,${scope} #d0007-root footer,${scope} #d0007-root .seg,${scope} #d0007-root .btn,${scope} #d0007-root .sched-flash,${scope} #d0007-root .sw-row,${scope} #d0007-root .sched-foot,${scope} #d0007-root .ev-m,${scope} #d0007-root .edited{display:none!important}
  ${scope} #d0007-root main{overflow:visible;padding:0}
  ${scope} #d0007-root .sched-h:before{content:"Event Schedule — "}
  ${scope} #d0007-root .sched-tbl{max-height:none;overflow:visible;border:0;border-radius:0}
  ${scope} #d0007-root .sched-table{min-width:0;width:100%;table-layout:auto}
  ${scope} #d0007-root .sched-table th,${scope} #d0007-root .sched-table td{position:static;font-size:9.5px;padding:3px 4px;border:1px solid #cfd8d0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  ${scope} #d0007-root .sched-table thead{display:table-header-group}
  ${scope} #d0007-root .sched-table tr{break-inside:avoid;page-break-inside:avoid}
  ${scope} #d0007-root .sched-gap td{height:4px;border:0}
  ${scope} #d0007-root .ed{margin:0;padding:0}
  ${scope} #d0007-root .ed .muted{visibility:hidden}
}`).join('')}
`);
  TABS.push({ id: 'schedule', label: 'Schedule', render: renderSchedule });
