  function downloadCSV(filename, head, rows) {
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
    const a = el('a', { href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })), download: filename }); document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  // --- shell ------------------------------------------------------------
  // Full screen overlay on top of the portal page. Esc or Close puts the
  // portal back exactly as it was.
  function addStyles() { if (!document.getElementById('d0007-css')) document.head.appendChild(el('style', { id: 'd0007-css' }, CSS_PARTS.join('\n'))); }
  let saidHello = false;
  function open() {
    if (root) { root.style.display = 'flex'; return; }
    if (!saidHello) { saidHello = true; try { console.info("Cam's VMS Console - built out of spite, mostly. Cam Prosic, Deputy Chief Ops, SJA Hamilton D0007."); } catch (e) { /* no console, no problem */ } }
    addStyles();
    root = el('div', { id: 'd0007-root', role: 'dialog', 'aria-label': APP_TITLE });
    root.innerHTML = `<header><h1>${esc(APP_TITLE)}</h1><span class="sp"></span><button class="btn" id="d7-refresh" title="Re-fetch everything from VMS">Refresh</button><button class="btn" id="d7-close">Close ✕</button></header>
      <nav>${TABS.map(t => `<button data-tab="${t.id}">${esc(t.label)}</button>`).join('')}</nav>
      <main></main>
      <footer>Live from your VMS session. Only the Hours tab writes anything back. Times in Eastern.</footer>`;
    document.body.appendChild(root);
    main = root.querySelector('main');
    root.querySelector('#d7-close').addEventListener('click', close);
    root.querySelector('#d7-refresh').addEventListener('click', () => { VMS.clear(); render(); });
    root.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; state.q = ''; render(); }));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && root && root.style.display !== 'none') close(); });
    render();
  }
  function close() { if (root) root.style.display = 'none'; }
