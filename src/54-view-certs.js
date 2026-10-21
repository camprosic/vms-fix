  // ---- Certifications ----
  function certState(expiry) { if (!expiry) return 'none'; const d = daysUntil(expiry); if (d === null) return 'none'; return d < 0 ? 'expired' : d <= CERT_WARN_DAYS ? 'expiring' : 'current'; }
  function certPill(expiry) { const s = certState(expiry); const d = daysUntil(expiry); return s === 'expired' ? pill(`Expired ${fmtD(expiry)}`, 'red') : s === 'expiring' ? pill(`Expires in ${d} d`, 'amber') : s === 'current' ? pill(`Valid to ${fmtD(expiry)}`, 'green') : pill('No expiry', 'grey'); }
  async function renderCerts() {
    const certs = (await VMS.certifications()).map(c => ({ ...c, state: certState(c.expiry), expD: toDate(c.expiry), effD: toDate(c.effective) }));
    const q = state.q;
    const counts = { expired: 0, expiring: 0, current: 0, none: 0 }; certs.forEach(c => counts[c.state]++);
    const rows = sortRows(certs.filter(c => (state.certFilter === 'all' || c.state === state.certFilter) && matches(q, c.name, c.qualification)), 'certs', 'expD', 1);
    main.innerHTML = `<div class="wrap">
      <div class="stats"><div class="stat ${counts.expired ? 'warn' : ''}"><b>${counts.expired}</b><span>expired</span></div><div class="stat ${counts.expiring ? 'warn' : ''}"><b>${counts.expiring}</b><span>expiring ≤ ${CERT_WARN_DAYS} days</span></div><div class="stat"><b>${counts.current}</b><span>current</span></div><div class="stat"><b>${new Set(certs.map(c => c.name)).size}</b><span>members with certs</span></div></div>
      <div class="bar">
        <div class="seg">${[['all', 'All'], ['expired', 'Expired'], ['expiring', 'Expiring'], ['current', 'Current'], ['none', 'No expiry']].map(([k, l]) => `<button data-cf="${k}" class="${state.certFilter === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <input type="search" placeholder="Filter by member or qualification…" value="${esc(q)}"><button class="btn" id="d7-csv">Download CSV</button>
      </div>
      <div class="tbl"><table><thead><tr>${th('Member', 'name', 'certs', 'expD')}${th('Qualification', 'qualification', 'certs', 'expD')}${th('Effective', 'effD', 'certs', 'expD')}${th('Expiry', 'expD', 'certs', 'expD')}<th>Status</th>${th('Source', 'source', 'certs', 'expD')}</tr></thead><tbody>
        ${rows.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.qualification)}</td><td>${esc(fmtD(c.effD) || c.effective)}</td><td>${esc(fmtD(c.expD) || c.expiry)}</td><td>${certPill(c.expiry)}</td><td class="muted">${esc(c.source)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted" style="font-size:12px">Source: Group Lead → Reports → Qualifications and Certifications. VMS only exposes certifications through windowed reports; this combines all of them (gained in the last two years, expired in the last 12 months, or expiring by the end of next year). Older certifications that expire later than next year are not visible.</p>
    </div>`;
    main.querySelectorAll('[data-cf]').forEach(b => b.addEventListener('click', () => { state.certFilter = b.dataset.cf; renderCerts(); }));
    const inp = main.querySelector('input[type=search]'); inp.addEventListener('input', () => { state.q = inp.value; renderCerts(); });
    bindSort(main, renderCerts);
    main.querySelector('#d7-csv').addEventListener('click', () => downloadCSV('d0007-certifications.csv', ['Member', 'Qualification', 'Effective', 'Expiry', 'Status', 'Source'], rows.map(c => [c.name, c.qualification, c.effective, c.expiry, c.state, c.source])));
  }
  TABS.push({ id: 'certs', label: 'Certifications', render: renderCerts });
