  // ---- Data ----
  // The unit-side data lives in this browser's localStorage. This is where it
  // gets moved to another browser, or wiped.
  const dataState = { mode: 'merge', confirm: false, msg: '' };
  async function renderData() {
    const counts = { schedule: Object.keys(Store.all('schedule')).length, members: Object.keys(Store.all('members')).length, settings: Object.keys(Store.all('settings')).length };
    main.innerHTML = `<div class="wrap">
      <div class="card"><h3>Local data</h3>
        <p class="muted">${counts.schedule} schedule row${counts.schedule === 1 ? '' : 's'} with edits · ${counts.members} member${counts.members === 1 ? '' : 's'} with tags · ${counts.settings} setting${counts.settings === 1 ? '' : 's'}</p>
        <div class="bar">
          <button class="btn" id="d7-export">Export JSON</button>
          <label class="btn">Import JSON… <input type="file" id="d7-import" accept=".json,application/json" style="display:none"></label>
          <span class="seg"><button data-mode="merge" class="${dataState.mode === 'merge' ? 'on' : ''}" title="Keep what's here, add or overwrite with the file's entries">Merge</button><button data-mode="replace" class="${dataState.mode === 'replace' ? 'on' : ''}" title="Throw away what's here and use the file">Replace</button></span>
        </div>
        ${dataState.msg ? `<div class="muted">${esc(dataState.msg)}</div>` : ''}
      </div>
      <div class="card"><h3>Reset</h3>
        <p class="muted">Clears every schedule edit, member tag and setting from this browser. Nothing in VMS is touched. Export first if there's any chance you'll want it back.</p>
        ${dataState.confirm
          ? `<div class="bar"><span>Really clear it all?</span><button class="btn" id="d7-reset-yes" style="border-color:#c2452f;color:#9a2b1d">Yes, reset local data</button><button class="btn" id="d7-reset-no">Cancel</button></div>`
          : `<button class="btn" id="d7-reset">Reset local data</button>`}
      </div>
      <div class="card"><h3>What lives where</h3>
        <ul style="margin:0;padding-left:18px">
          <li><b>From VMS, read live:</b> events, locations, start dates, sign-ups, shifts (so meet-at-event, approx. end and the names on the schedule), roster, hours, certifications. Refresh re-fetches it.</li>
          <li><b>In this browser only:</b> schedule cells VMS has no field for (Meet @ St.John, coordinator, requirement, notes, equipment, vehicle, row colour, any time you've overridden), and member tags (MFR/Apprentice override, C / D / Sr, home unit). Stored under <code>${esc(Store.KEY)}</code> in localStorage. It doesn't sync anywhere; export and import to pass it to someone else.</li>
        </ul>
      </div>
    </div>`;
    main.querySelector('#d7-export').addEventListener('click', () => {
      const a = el('a', { href: URL.createObjectURL(new Blob([Store.exportJSON()], { type: 'application/json' })), download: `d0007-local-data-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    });
    main.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { dataState.mode = b.dataset.mode; renderData(); }));
    main.querySelector('#d7-import').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = () => { try { Store.importJSON(String(rd.result), { merge: dataState.mode === 'merge' }); dataState.msg = `Imported ${f.name} (${dataState.mode}).`; } catch (err) { dataState.msg = `Couldn't import ${f.name}: ${err.message || err}`; } renderData(); };
      rd.onerror = () => { dataState.msg = `Couldn't read ${f.name}.`; renderData(); };
      rd.readAsText(f);
    });
    const on = (id, fn) => { const b = main.querySelector(id); if (b) b.addEventListener('click', fn); };
    on('#d7-reset', () => { dataState.confirm = true; renderData(); });
    on('#d7-reset-no', () => { dataState.confirm = false; renderData(); });
    on('#d7-reset-yes', () => { Store.reset(); dataState.confirm = false; dataState.msg = 'Local data cleared.'; renderData(); });
  }
  TABS.push({ id: 'data', label: 'Data', render: renderData });
