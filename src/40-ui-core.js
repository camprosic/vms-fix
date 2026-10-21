  // --- ui -------------------------------------------------------------
  const state = { tab: 'events', evSet: 'upcoming', openEvent: null, hoursWin: '', hoursBy: 'volunteer', q: '', certFilter: 'all', sort: {}, rosterSel: null };
  let root = null, main = null;

  function pill(text, cls = '') { return `<span class="pill ${cls}">${esc(text)}</span>`; }
  function statusPill(s) { const n = norm(s); const cls = /cancel|declin|reject/.test(n) ? 'red' : /pending|review|draft/.test(n) ? 'amber' : /approv|complet|publish|active|confirm/.test(n) ? 'green' : 'grey'; return pill(s || '—', cls); }
  function sortRows(rows, key, defKey, defDir = 1) {
    const s = state.sort[key] || { k: defKey, d: defDir };
    return [...rows].sort((a, b) => { const x = a[s.k], y = b[s.k]; const r = typeof x === 'number' && typeof y === 'number' ? x - y : (x instanceof Date || y instanceof Date) ? ((x?.getTime() || 0) - (y?.getTime() || 0)) : norm(x).localeCompare(norm(y)); return r * s.d; });
  }
  function th(label, key, tableKey, defKey, numeric = false) {
    const s = state.sort[tableKey] || { k: defKey, d: 1 };
    const on = s.k === key;
    return `<th class="${numeric ? 'n ' : ''}${on ? 'sorted ' + (s.d > 0 ? 'asc' : '') : ''}" data-sort="${key}" data-table="${tableKey}">${esc(label)}</th>`;
  }
  function bindSort(container, rerender) {
    container.querySelectorAll('th[data-sort]').forEach(h => h.addEventListener('click', () => { const t = h.dataset.table, k = h.dataset.sort; const cur = state.sort[t]; state.sort[t] = cur && cur.k === k ? { k, d: -cur.d } : { k, d: 1 }; rerender(); }));
  }
  const matches = (q, ...fields) => !q || fields.some(f => norm(f).includes(norm(q)));

  // Each render gets a ticket; a slow tab that finishes after you've already
  // switched away must not paint over the new one.
  let renderTicket = 0;
  function render() {
    const ticket = ++renderTicket;
    root.querySelector('nav').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
    main.innerHTML = '<div class="load">Loading…</div>';
    const tab = TABS.find(t => t.id === state.tab) || TABS[0];
    Promise.resolve().then(() => tab.render()).catch(e => { if (ticket === renderTicket) main.innerHTML = `<div class="wrap"><div class="err"><b>Couldn't load data.</b> ${esc(e.message || e)}</div></div>`; });
  }
  // Screens call this before writing to main after an await: if it returns
  // false the user has moved on and the screen should just stop.
  const stillCurrent = tabId => state.tab === tabId;
