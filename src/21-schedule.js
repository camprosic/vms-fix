  // --- schedule ----------------------------------------------------------
  // The unit runs on a monthly spreadsheet. One row per event day, meet time,
  // end time, location, whos on it split into MFRs and Apprentices. Every
  // month someone sits there with VMS open in one tab and the sheet in the
  // other and copies it across by hand. This tab is the VMS side of that,
  // already in the sheets shape, so its a copy-paste and not an evening.
  //
  // Everything here comes from VMS. Nothing is typed in, nothing is stored.
  // The columns VMS has no idea about (meet at event, kit, vehicle, notes) are
  // left blank in the export for whoever keeps the sheet.
  //
  // Where it all comes from, because it is not one place:
  //  - the event list: Group Lead > Events subgrids (20-vms.js groupEvents)
  //  - shift definitions ("MFR 16:00-23:00, max 10, 3 booked"): the PUBLIC
  //    event page. Thats the only place a group lead can see them. Really.
  //  - whos booked: the event-summary page's Reported Shifts grid
  //  - which shift someone booked (so, MFR or Apprentice): only visible on the
  //    bookings approval form, one page per booking. So we read them. Certs
  //    are the first guess while thats loading.
  //  - street address: the web api, one of about ten columns it still gives us
  //  - on-site contact: the event REQUEST form. Only while the request is
  //    still pending. Approve it and VMS hides the phone number. Great.
  const Schedule = (() => {
    const COLUMNS = ['Event', 'Date', 'Meet @ St.John', 'Meet @ Event', 'Approx. End', 'Event Location', 'On-Site Coordinator', 'Event Notes', 'Medical First Responders', 'Apprentice', 'Equipment', 'Vehicle'];
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    // Unit rule VMS doesnt know about: an apprentice cant be on a shift without
    // an MFR to work under. One MFR per apprentice. Change it here if that ever
    // changes.
    const MFR_PER_APPRENTICE = 1;

    // --- dates, all in Eastern. Never use the local getters here, the browser
    //     could be anywhere and VMS stores everything in UTC.
    const F_NUM = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const F_LABEL = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
    const partsOf = (fmt, d) => { const o = {}; fmt.formatToParts(d).forEach(p => { if (p.type !== 'literal') o[p.type] = p.value; }); return o; };
    const ymd = v => { const d = toDate(v); if (!d) return ''; const p = partsOf(F_NUM, d); return `${p.year}-${p.month}-${p.day}`; };
    const hm = v => { const d = toDate(v); if (!d) return ''; const p = partsOf(F_NUM, d); return `${p.hour}:${p.minute}`; };
    const dayLabel = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); if (!m) return ''; const p = partsOf(F_LABEL, new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12))); return `${p.weekday} ${p.month} ${p.day}`; };
    const today = () => { const p = partsOf(F_NUM, new Date()); return { year: +p.year, month: +p.month }; };
    const monthLabel = (y, m) => `${MONTHS[m - 1] || ''} ${y}`;
    const minute = d => d ? Math.round(d.getTime() / 60000) : null;

    const isCancelled = s => /cancel/i.test(s || '');
    const isWaitlist = s => /wait ?list/i.test(s || '');
    const isNoShow = s => /no.?show/i.test(s || '');
    // Shift definition names are free text but every one of ours starts with
    // MFR or Apprentice ("MFR", "MFR day 3", "Apprentice - Sat").
    const kindOf = name => /^\s*mfr/i.test(name || '') ? 'MFR' : /^\s*apprentice/i.test(name || '') ? 'Apprentice' : 'Other';

    // --- roles. The thing I got wrong the first time: certs are NOT how VMS
    //     decides who is an MFR on an event, the booked shift is. Someone with
    //     a current MFR cert who booked the Apprentice shift is on the sheet as
    //     an apprentice that day. So: shift title first, certs only while the
    //     forms are loading or when a title is something unhelpful.
    const formCache = new Map();        // booking id -> { role, shiftName } for the session
    const roleByName = new Map();       // name -> last role seen on a booked shift this session (the roster uses it)
    const certRole = (name, certs) => (D.mfrCertOf ? D.mfrCertOf(name, certs) : null) ? 'MFR' : 'Apprentice';
    async function roleFromForm(bookingId) {
      if (formCache.has(bookingId)) return formCache.get(bookingId);
      let out = null;
      try {
        const f = await Approvals.loadForm(bookingId);
        const kind = kindOf((f.scheduleName || '').split(' - ')[0]);
        out = { role: kind === 'Other' ? null : kind, shiftName: f.scheduleName || '' };
      } catch (e) { out = { role: null, shiftName: '', error: e.message || String(e) }; }
      formCache.set(bookingId, out);
      return out;
    }

    async function pmap(items, fn, n = 4) {
      const out = new Array(items.length); let i = 0;
      await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
      return out;
    }

    // --- one event -> its rows
    function eventRows(e, detail, pub, extra, ctx) {
      const defsAll = (pub && pub.shifts ? pub.shifts : []).filter(d => !d.cancelled && d.start).map(d => ({ ...d, kind: kindOf(d.name), day: ymd(d.start), hours: d.end ? r2((d.end - d.start) / 3600000) : null, needed: d.max === null ? null : d.max - d.booked }));
      const bookings = (detail.shifts || []).filter(s => s.start && !isCancelled(s.status)).map(s => ({ ...s, day: ymd(s.start), end: new Date(s.start.getTime() + (s.hours || 0) * 3600000) }));
      const days = [...new Set([...defsAll.map(d => d.day), ...bookings.map(b => b.day)])].filter(Boolean).sort();
      if (!days.length && e.start) days.push(ymd(e.start));
      const bookedNames = new Set(bookings.map(b => norm(b.name)));
      const noShift = (detail.participants || []).filter(p => !isCancelled(p.status) && !bookedNames.has(norm(p.name))).map(p => p.name).sort((a, b) => norm(a).localeCompare(norm(b)));
      const req = matchRequest(e, ctx.requests);
      const address = extra ? { street: extra.street, city: extra.city, province: extra.province, postal: extra.postal } : (req ? req.address : null);
      const up = ctx.staffing.get(e.id) || null;
      return days.map((day, i) => {
        const defs = defsAll.filter(d => d.day === day).sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
        const people = bookings.filter(b => b.day === day).map(b => {
          const cached = formCache.get(b.id);
          const role = cached && cached.role ? cached.role : certRole(b.name, ctx.certs);
          return { id: b.id, name: b.name, start: b.start, end: b.end, hours: b.hours, status: b.status, role, roleSource: cached && cached.role ? 'shift' : 'cert', shiftName: cached ? cached.shiftName : '', partial: null };
        });
        const starts = defs.length ? defs.map(d => d.start) : people.map(p => p.start);
        const ends = defs.length ? defs.map(d => d.end).filter(Boolean) : people.map(p => p.end);
        const meetSJDate = starts.length ? new Date(Math.min(...starts.map(d => d.getTime()))) : null;
        const approxEndDate = ends.length ? new Date(Math.max(...ends.map(d => d.getTime()))) : null;
        const row = {
          key: `${e.id}|${day}`,
          event: { id: e.id, title: e.title, status: e.status, program: e.program, description: (extra && extra.description) || (pub && pub.description) || '', locationName: e.location || (pub && pub.location) || '', address, link: `/en-US/group-lead/event-summary/?eventid=${encodeURIComponent(e.id)}&groupid=${GROUP_ID}`, publicId: pub ? pub.publicId : null, publicLink: pub ? `/engagement/?id=${encodeURIComponent(pub.publicId)}` : null },
          date: day, dateLabel: dayLabel(day), isFirst: i === 0,
          defs, people, noShift: i === 0 ? noShift : [],
          meetSJDate, approxEndDate, meetSJ: hm(meetSJDate), approxEnd: hm(approxEndDate),
          contact: req ? req.contact : null, organizer: req ? req.organizer : null, request: req,
          quals: [...new Set([...(pub ? pub.quals : []), ...(up ? up.quals : [])])],
          vmsStaffing: up ? { signedUp: up.signedUp, minimum: up.minimum, needed: up.needed } : null,
          needsCheck: false, notes: [], staffing: null,
        };
        finalize(row);
        return row;
      });
    }

    // Match an event to a pending request by name (+/- a few characters) and a
    // start within a day. Requests dont carry the event id. Of course not.
    function matchRequest(e, requests) {
      if (!requests || !requests.length) return null;
      const n = norm(e.title), s = e.start ? e.start.getTime() : null;
      return requests.find(r => { const rn = norm(r.name); if (!rn || !(rn === n || rn.startsWith(n) || n.startsWith(rn))) return false; if (!s || !r.start) return true; return Math.abs(r.start.getTime() - s) <= 36 * 3600000; }) || null;
    }

    // Partial-shift markers, staffing and whether the role split still needs
    // checking against VMS. Re-run after roles resolve.
    function finalize(row) {
      const byKind = kind => row.defs.filter(d => d.kind === kind);
      const window = p => { const d = byKind(p.role)[0]; return d ? { start: d.start, end: d.end } : { start: row.meetSJDate, end: row.approxEndDate }; };
      const variants = [];
      row.people.forEach(p => {
        const w = window(p);
        const ds = w.start && minute(p.start) !== minute(w.start), de = w.end && minute(p.end) !== minute(w.end);
        if (!ds && !de) { p.partial = null; return; }
        const text = ds && de ? `${hm(p.start)} to ${hm(p.end)}` : ds ? `${hm(p.start)} to End` : `Start to ${hm(p.end)}`;
        let v = variants.find(x => x.text === text); if (!v) { v = { text, mark: '*'.repeat(variants.length + 2) }; variants.push(v); }
        p.partial = { text, mark: v.mark, nameMark: v.mark.slice(1) };
      });
      row.notes = variants.map(v => `${v.mark}${v.text}`);
      row.people.sort((a, b) => a.role.localeCompare(b.role) || norm(a.name).localeCompare(norm(b.name)));
      // staffing: by shift type, from VMS's own booked counts on the definitions
      // (those are exact), with our rule about apprentices on top
      const sum = (kind, f) => byKind(kind).reduce((a, d) => a + (f(d) || 0), 0);
      const hasMax = kind => byKind(kind).some(d => d.max !== null);
      const counted = kind => row.people.filter(p => p.role === kind && !isNoShow(p.status) && !isWaitlist(p.status)).length;
      const mfr = { booked: row.defs.length ? sum('MFR', d => d.booked) : counted('MFR'), max: hasMax('MFR') ? sum('MFR', d => d.max) : null };
      const app = { booked: row.defs.length ? sum('Apprentice', d => d.booked) : counted('Apprentice'), max: hasMax('Apprentice') ? sum('Apprentice', d => d.max) : null };
      mfr.needed = mfr.max === null ? 0 : Math.max(0, mfr.max - mfr.booked);
      app.over = app.max === null ? 0 : Math.max(0, app.booked - app.max);
      const uncovered = Math.max(0, app.booked - mfr.booked * MFR_PER_APPRENTICE);   // apprentices with no MFR to work under
      const problems = [];
      if (mfr.needed) problems.push(`${mfr.needed} MFR${mfr.needed === 1 ? '' : 's'} short of the ${mfr.max} VMS asks for`);
      if (uncovered) problems.push(`${uncovered} apprentice${uncovered === 1 ? '' : 's'} with no MFR to work under (${app.booked} apprentice${app.booked === 1 ? '' : 's'}, ${mfr.booked} MFR${mfr.booked === 1 ? '' : 's'})`);
      if (app.over) problems.push(`${app.over} more apprentice${app.over === 1 ? '' : 's'} than the shift allows`);
      row.staffing = { mfr, app, uncovered, problems, ok: !mfr.needed && !uncovered, level: mfr.needed || uncovered ? 'short' : app.over ? 'warn' : 'ok', known: row.defs.length > 0 };
      // does the name split agree with VMS's counts? if not the forms get read
      row.needsCheck = row.defs.length > 0 && row.people.some(p => p.roleSource !== 'shift') && (counted('MFR') !== mfr.booked || counted('Apprentice') !== app.booked);
      return row;
    }

    // --- the month
    async function monthRows(year, month, { onProgress } = {}) {
      const prefix = `${year}-${String(month).padStart(2, '0')}`;
      const say = (phase, done, total) => { if (onProgress) onProgress({ phase, done, total }); };
      say('events', 0, 0);
      const [ev, certs, up, requests] = await Promise.all([VMS.groupEvents(), VMS.certifications().catch(() => []), VMS.upcomingEngagements().catch(() => []), VMS.pendingRequests().catch(() => [])]);
      const seen = new Set(), events = [];
      ['current', 'upcoming', 'past'].forEach(k => (ev[k] || []).forEach(e => { if (e.id && !seen.has(e.id)) { seen.add(e.id); events.push(e); } }));
      // Only open events that could have a day in this month: anything starting
      // in the six weeks before it (a fair that straddles the month end) up to
      // the end of it. Past events go back years and every one is three fetches.
      const lo = ymd(new Date(Date.UTC(year, month - 1, 1) - 45 * 86400000)), hi = `${prefix}-31`;
      const cand = events.filter(e => { const s = ymd(e.start); return s && s >= lo && s <= hi; });
      const ids = cand.map(e => e.id);
      const [extras, pubIds] = await Promise.all([VMS.eventExtras(ids).catch(() => new Map()), VMS.publicIdsFor(ids).catch(() => new Map())]);
      let done = 0;
      const got = await pmap(cand, async e => {
        const [detail, pub] = await Promise.all([
          VMS.eventDetail(e.id).catch(err => ({ error: err.message || String(err), participants: [], shifts: [] })),
          pubIds.get(e.id) ? VMS.publicEvent(pubIds.get(e.id)).catch(() => null) : Promise.resolve(null),
        ]);
        say('events', ++done, cand.length);
        return { detail, pub };
      }, 4);
      const ctx = { certs, requests, staffing: new Map(up.map(u => [u.id, u])) };
      const rows = [];
      cand.forEach((e, i) => eventRows(e, got[i].detail, got[i].pub, extras.get(e.id), ctx).forEach(r => { if (r.date.startsWith(prefix)) rows.push(r); }));
      rows.sort((a, b) => a.date.localeCompare(b.date) || (minute(a.meetSJDate) || 0) - (minute(b.meetSJDate) || 0) || norm(a.event.title).localeCompare(norm(b.event.title)));
      return rows;
    }

    // Read the approval form for every booking we havent seen this session and
    // put people in the column VMS actually has them in. One page per booking,
    // three at a time. onEach fires per row as it settles so the screen can
    // repaint rows instead of waiting for the whole month.
    async function resolveRoles(rows, { onProgress, onRow, all = true } = {}) {
      const todo = rows.filter(r => all ? r.people.some(p => p.roleSource !== 'shift') : r.needsCheck);
      const ids = [...new Set(todo.flatMap(r => r.people.filter(p => p.roleSource !== 'shift').map(p => p.id)))];
      let done = 0;
      if (onProgress) onProgress({ phase: 'roles', done, total: ids.length });
      const settled = new Set();
      await pmap(ids, async id => {
        await roleFromForm(id);
        done++; if (onProgress) onProgress({ phase: 'roles', done, total: ids.length });
        // repaint any row whose people are all accounted for now
        settled.add(id);
        for (const r of todo) if (!r._done && r.people.every(p => p.roleSource === 'shift' || settled.has(p.id))) { r._done = true; applyRoles(r); if (onRow) onRow(r); }
      }, 3);
      todo.forEach(r => { if (!r._done) { r._done = true; applyRoles(r); if (onRow) onRow(r); } });
      return rows;
    }
    function applyRoles(row) {
      row.people.forEach(p => { const c = formCache.get(p.id); if (c && c.role) { p.role = c.role; p.roleSource = 'shift'; p.shiftName = c.shiftName; roleByName.set(norm(p.name), c.role); } else if (c) { p.shiftName = c.shiftName; p.roleSource = c.error ? 'cert' : 'cert'; } });
      finalize(row);
      row.needsCheck = false;
    }

    // --- the sheets cells
    const nameOf = p => `${p.name}${p.partial ? p.partial.nameMark : ''}`;
    const addrLines = r => { const a = r.event.address; return [r.event.locationName, a && a.street, a && [a.city, a.province].filter(Boolean).join(', ') + (a.postal ? `  ${a.postal}` : '')].map(x => (x || '').trim()).filter(Boolean); };
    const contactLines = r => r.contact ? [r.contact.name, r.contact.phone, r.contact.email].filter(Boolean) : [];
    const onSheet = p => !isNoShow(p.status) && !isWaitlist(p.status);
    function rowCells(r) {
      const names = role => r.people.filter(p => p.role === role && onSheet(p)).map(nameOf).join('\n');
      return [r.event.title, r.dateLabel, r.meetSJ, '', r.approxEnd, addrLines(r).join('\n'), contactLines(r).join('\n'), r.notes.join('\n'), names('MFR'), names('Apprentice'), '', ''].map(v => String(v ?? ''));
    }
    // Header first, a blank spacer between dates like the sheet does.
    function toWorkbookRows(rows, { spacers = true } = {}) {
      const out = [COLUMNS.slice()]; let prev = null;
      (rows || []).forEach(r => { if (spacers && prev && prev !== r.date) out.push(COLUMNS.map(() => '')); out.push(rowCells(r)); prev = r.date; });
      return out;
    }
    const tsvCell = v => /[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const toTSV = (rows, opts) => toWorkbookRows(rows, opts).map(r => r.map(tsvCell).join('\t')).join('\n');

    // --- .xlsx, written by hand. An xlsx is a zip of a few XML files and the
    //     month is a few KB, so: stored zip, no library, no CDN.
    const WIDTHS = [28, 11, 9, 9, 9, 28, 22, 20, 26, 22, 12, 12];
    const lines = s => String(s || '').split(/\r?\n/).filter(Boolean);
    const xmlEsc = s => String(s ?? '').replace(/[^\t\n\r\x20-￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const colRef = i => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
    const utf8 = s => { const o = []; for (const ch of s) { const c = ch.codePointAt(0); if (c < 0x80) o.push(c); else if (c < 0x800) o.push(0xC0 | c >> 6, 0x80 | c & 63); else if (c < 0x10000) o.push(0xE0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63); else o.push(0xF0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63); } return Uint8Array.from(o); };
    const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
    const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
    function zipStored(files) {
      const u16 = n => [n & 255, n >>> 8 & 255], u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
      const now = new Date(), tm = now.getHours() << 11 | now.getMinutes() << 5 | now.getSeconds() >> 1, dt = (now.getFullYear() - 1980) << 9 | (now.getMonth() + 1) << 5 | now.getDate();
      const parts = [], central = []; let off = 0;
      for (const f of files) {
        const name = utf8(f.name), data = utf8(f.text), crc = crc32(data);
        const local = Uint8Array.from([...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(tm), ...u16(dt), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)]);
        central.push(Uint8Array.from([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(tm), ...u16(dt), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off)]), name);
        parts.push(local, name, data); off += local.length + name.length + data.length;
      }
      const cdSize = central.reduce((a, b) => a + b.length, 0);
      const end = Uint8Array.from([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(off), ...u16(0)]);
      const all = [...parts, ...central, end], out = new Uint8Array(all.reduce((a, b) => a + b.length, 0)); let p = 0; all.forEach(b => { out.set(b, p); p += b.length; });
      return out;
    }
    function toXLSX(rows, { sheetName = 'Schedule' } = {}) {
      const aoa = toWorkbookRows(rows);
      const name = String(sheetName).replace(/[\[\]:*?\/\\]/g, '').slice(0, 31) || 'Schedule';
      const sheetRows = aoa.map((cells, ri) => {
        const s = ri === 0 ? 1 : 0;
        const nLines = Math.max(1, ...cells.map((v, ci) => lines(v).reduce((a, l) => a + Math.max(1, Math.ceil(l.length / WIDTHS[ci])), 0)));
        const cs = cells.map((v, ci) => v === '' ? (s ? `<c r="${colRef(ci)}${ri + 1}" s="${s}"/>` : '') : `<c r="${colRef(ci)}${ri + 1}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`).join('');
        return `<row r="${ri + 1}" ht="${15 * nLines + 3}" customHeight="1">${cs}</row>`;
      }).join('');
      const xml = body => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
      const align = '<alignment vertical="top" wrapText="1"/>';
      const sheet = xml(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${colRef(COLUMNS.length - 1)}${aoa.length}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${WIDTHS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${sheetRows}</sheetData><pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`);
      const styles = xml(`<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1">${align}</xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">${align}</xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
      return zipStored([
        { name: '[Content_Types].xml', text: xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>') },
        { name: '_rels/.rels', text: xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
        { name: 'xl/workbook.xml', text: xml(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
        { name: 'xl/_rels/workbook.xml.rels', text: xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') },
        { name: 'xl/styles.xml', text: styles },
        { name: 'xl/worksheets/sheet1.xml', text: sheet },
      ]);
    }

    return { COLUMNS, MFR_PER_APPRENTICE, monthRows, resolveRoles, eventRows, finalize, kindOf, roleFromForm, roleByName, formCache, rowCells, toTSV, toWorkbookRows, toXLSX, ymd, hm, dayLabel, today, monthLabel };
  })();
  D.Schedule = Schedule;
