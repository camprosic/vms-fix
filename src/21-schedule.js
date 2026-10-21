  // --- event schedule ---------------------------------------------------
  // The unit's monthly Event Schedule: one row per event day, who's on it,
  // when to meet, what kit, which truck. Until now that was an Excel sheet
  // filled in by hand from the VMS event pages, one event at a time, every
  // month. VMS has the event, the location, the sign-ups and the shifts. It has
  // no field for anything else on the sheet (meet-at-St.John time, coordinator,
  // requirement, notes, kits, vehicles, row colour, who's Command/Driver/Sr),
  // so those live in Store and get merged over the VMS side here.
  const Schedule = (() => {
    const COLUMNS = ['Event', 'Date', 'Meet @ St.John', 'Meet @ Event', 'Approx. End', 'Event Location', 'On-Site Coordinator', 'Event Notes', 'Medical First Responders', 'Apprentice', 'Equipment', 'Vehicle'];
    // The sheet's row fills. Red and cyan are in use but nobody wrote down what for.
    const COLOURS = [
      { hex: '#FFFF00', label: 'Stadium / sports' },
      { hex: '#00FF00', label: 'Community event' },
      { hex: '#FF00FF', label: 'Training night' },
      { hex: '#4A86E8', label: 'Multi-day / provincial' },
      { hex: '#FF0000', label: 'Red' },
      { hex: '#FF9900', label: 'Training exercise' },
      { hex: '#00FFFF', label: 'Cyan' },
    ];
    const TAGS = ['C', 'D', 'Sr'];
    const FIELDS = ['meetSJ', 'meetEvent', 'approxEnd', 'coordinator', 'notes', 'requirement', 'equipment', 'vehicle', 'colour'];
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

    // --- dates. Everything is keyed on the Eastern calendar date, worked out
    // through Intl so it doesn't matter what zone the browser thinks it's in.
    const F_NUM = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const F_LABEL = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
    const partsOf = (fmt, d) => { const o = {}; fmt.formatToParts(d).forEach(p => { if (p.type !== 'literal') o[p.type] = p.value; }); return o; };
    const ymd = v => { const d = toDate(v); if (!d) return ''; const p = partsOf(F_NUM, d); return `${p.year}-${p.month}-${p.day}`; };
    const hm = v => { const d = toDate(v); if (!d) return ''; const p = partsOf(F_NUM, d); return `${p.hour}:${p.minute}`; };
    // "Sat Oct 24" for a YYYY-MM-DD. Noon UTC is still that date in Eastern.
    const dayLabel = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); if (!m) return ''; const p = partsOf(F_LABEL, new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12))); return `${p.weekday} ${p.month} ${p.day}`; };
    const today = () => { const p = partsOf(F_NUM, new Date()); return { year: +p.year, month: +p.month }; };
    const monthName = m => MONTHS[m - 1] || '';
    const monthLabel = (y, m) => `${monthName(m)} ${y}`;

    const isCancelled = s => /cancel/i.test(s || '');
    const isWaitlist = s => /wait ?list/i.test(s || '');
    const isNoShow = s => /no.?show/i.test(s || '');

    // --- roles and tags. Apprentice unless there's a current MFR cert on file,
    // and whatever is set on the Roster tab wins over that.
    const MFR_RE = /medical first responder/i;
    function autoRole(name, certs = [], now = Date.now()) {
      const n = norm(name);
      const ok = certs.some(c => norm(c.name) === n && MFR_RE.test(c.qualification || '') && (!c.expiry || ((toDate(c.expiry)?.getTime() ?? 0) + 86400000) > now));
      return ok ? 'MFR' : 'Apprentice';
    }
    function memberInfo(name, { certs = [], members = {}, now } = {}) {
      const m = members[norm(name)] || {};
      const auto = autoRole(name, certs, now);
      const set = m.role === 'MFR' || m.role === 'Apprentice';
      return { role: set ? m.role : auto, autoRole: auto, roleSet: set, tags: TAGS.filter(t => Array.isArray(m.tags) && m.tags.includes(t)), unit: String(m.unit || '').trim() };
    }

    // --- one day's shifts → meet time, end time, people, partial-shift notes.
    // The "main" shift is the start time most people share (earliest on a tie)
    // and its most common length. Anyone whose window differs is partial: they
    // get a star on their name and a line in the notes, one star-group per
    // distinct window in the order they turn up.
    function deriveDay(shifts) {
      const by = new Map();
      shifts.forEach(s => {
        const start = toDate(s.start); if (!start || isCancelled(s.status)) return;
        const end = new Date(start.getTime() + Math.max(0, num(s.hours)) * 3600000);
        const k = norm(s.name);
        const cur = by.get(k);
        if (!cur) by.set(k, { name: s.name, start, end, hours: num(s.hours), status: s.status || '' });
        else { if (start < cur.start) cur.start = start; if (end > cur.end) cur.end = end; cur.hours += num(s.hours); if (isNoShow(cur.status) && !isNoShow(s.status)) cur.status = s.status || ''; }
      });
      const all = [...by.values()].sort((a, b) => a.start - b.start || norm(a.name).localeCompare(norm(b.name)));
      const waitlisted = all.filter(p => isWaitlist(p.status)).map(p => ({ name: p.name, status: p.status }));
      const people = all.filter(p => !isWaitlist(p.status));
      const counted = people.filter(p => !isNoShow(p.status));
      const pool = counted.length ? counted : people;
      const mode = (items, key, tie) => { const c = new Map(); items.forEach(x => c.set(key(x), (c.get(key(x)) || 0) + 1)); let best = null; for (const x of items) { const k = key(x); if (!best || c.get(k) > best.n || (c.get(k) === best.n && tie(x, best.x))) best = { x, n: c.get(k), k }; } return best ? best.x : null; };
      const lead = mode(pool, p => p.start.getTime(), (a, b) => a.start < b.start);
      const mainStart = lead ? lead.start : null;
      const same = pool.filter(p => mainStart && p.start.getTime() === mainStart.getTime());
      const lengthLead = mode(same, p => p.hours, (a, b) => a.hours > b.hours);
      const mainEnd = mainStart ? new Date(mainStart.getTime() + (lengthLead ? lengthLead.hours : 0) * 3600000) : null;
      const meetEvent = mainStart ? hm(mainStart) : '';
      const approxEnd = mainEnd && mainEnd > mainStart ? hm(mainEnd) : '';
      const notes = [], variants = new Map();
      const out = people.map(p => {
        const partialOf = mainStart && (p.start.getTime() !== mainStart.getTime() || p.end.getTime() !== mainEnd.getTime());
        let partial = null;
        if (partialOf) {
          const vk = p.start.getTime() + '-' + p.end.getTime();
          if (!variants.has(vk)) {
            const marker = '*'.repeat(variants.size + 2);
            variants.set(vk, marker);
            notes.push(`${marker}${hm(p.start)} to ${p.end.getTime() === mainEnd.getTime() ? 'End' : hm(p.end)}`);
          }
          const marker = variants.get(vk);
          partial = { start: hm(p.start), end: hm(p.end), marker, mark: marker.slice(1) };
        }
        return { name: p.name, start: p.start, end: p.end, hours: p.hours, status: p.status, partial };
      });
      return { meetEvent, approxEnd, mainStart, mainEnd, people: out, notes, waitlisted };
    }

    // --- one event (+ its detail) → one row per day it has shifts on. No
    // shifts at all and it gets one row on its start date so it still shows up.
    const peopleOrder = (a, b) => { const r = t => a.tags.includes(t) === b.tags.includes(t) ? 0 : a.tags.includes(t) ? -1 : 1; return r('C') || r('D') || norm(a.name).localeCompare(norm(b.name)); };
    function eventRows(e, detail, ctx = {}) {
      const d = detail || {};
      const info = name => memberInfo(name, ctx);
      const byDay = new Map();
      (d.shifts || []).forEach(s => { if (isCancelled(s.status)) return; const k = ymd(s.start); if (!k) return; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(s); });
      const days = byDay.size ? [...byDay.keys()].sort() : [ymd(e.start)].filter(Boolean);
      const scheduled = new Set((d.shifts || []).filter(s => !isCancelled(s.status)).map(s => norm(s.name)));
      // Signed up but never given a shift, on any day. Worth a nudge.
      const signedUpNoShift = (d.participants || []).filter(p => !isCancelled(p.status) && !/declin|reject/i.test(p.status || '') && !scheduled.has(norm(p.name))).map(p => ({ name: p.name, status: p.status, role: info(p.name).role }));
      const startDay = ymd(e.start);
      return days.map(date => {
        const day = deriveDay(byDay.get(date) || []);
        const people = day.people.map(p => ({ ...p, ...info(p.name) })).sort(peopleOrder);
        const row = {
          key: `${e.id}|${date}`, eventId: e.id, title: e.title || '', location: e.location || '', program: e.program || '', eventStatus: e.status || '',
          date, dateLabel: dayLabel(date), eventStart: e.start || null, startMismatch: !!startDay && startDay !== date && byDay.size > 0 && date === days[0],
          derived: { meetEvent: day.meetEvent, approxEnd: day.approxEnd, notes: day.notes },
          people, signedUpNoShift, waitlisted: day.waitlisted.map(w => ({ ...w, role: info(w.name).role })), shiftCount: (byDay.get(date) || []).length,
          error: d.error || '',
        };
        return withOverrides(row);
      });
    }

    // Merge what's in Store over the derived values. Empty override = use VMS.
    function withOverrides(row) {
      const st = Store.get('schedule', row.key) || {};
      const pick = (f, dflt = '') => { const v = st[f]; return v === undefined || v === null || String(v) === '' ? dflt : String(v); };
      const out = { ...row, stored: { ...st } };
      out.meetSJ = pick('meetSJ'); out.meetEvent = pick('meetEvent', row.derived.meetEvent); out.approxEnd = pick('approxEnd', row.derived.approxEnd);
      out.coordinator = pick('coordinator'); out.notes = pick('notes'); out.requirement = pick('requirement'); out.equipment = pick('equipment'); out.vehicle = pick('vehicle');
      const col = pick('colour').toUpperCase(); out.colour = COLOURS.some(c => c.hex === col) ? col : '';
      out.edited = { meetEvent: !!pick('meetEvent') && pick('meetEvent') !== row.derived.meetEvent, approxEnd: !!pick('approxEnd') && pick('approxEnd') !== row.derived.approxEnd };
      return out;
    }

    // Run fn over items with at most n in flight. The event-summary page is
    // three fetches per event and there's no need to hit the portal with
    // thirty of them at once.
    async function pmap(items, fn, n = 4) {
      const out = new Array(items.length); let i = 0;
      await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
      return out;
    }

    async function monthRows(year, month) {
      const prefix = `${year}-${String(month).padStart(2, '0')}`;
      const [ev, certs] = await Promise.all([VMS.groupEvents(), VMS.certifications().catch(() => [])]);
      const members = Store.all('members');
      const seen = new Set(), events = [];
      ['current', 'upcoming', 'past'].forEach(k => (ev[k] || []).forEach(e => { if (e.id && !seen.has(e.id)) { seen.add(e.id); events.push(e); } }));
      // Only open events that could have a day in this month: anything starting
      // in the six weeks before it (a fair that runs across the month end) up to
      // the end of it. Past events go back years and every one is three fetches.
      const lo = ymd(new Date(Date.UTC(year, month - 1, 1) - 45 * 86400000)), hi = `${prefix}-31`;
      const cand = events.filter(e => { const s = ymd(e.start); return s && s >= lo && s <= hi; });
      const details = await pmap(cand, e => VMS.eventDetail(e.id).catch(err => ({ error: err.message || String(err), participants: [], shifts: [] })), 4);
      const rows = [];
      cand.forEach((e, i) => eventRows(e, details[i], { certs, members }).forEach(r => { if (r.date.startsWith(prefix)) rows.push(r); }));
      rows.sort((a, b) => a.date.localeCompare(b.date) || a.meetEvent.localeCompare(b.meetEvent) || norm(a.title).localeCompare(norm(b.title)));
      return rows;
    }

    // --- the sheet's cells
    const formatName = p => `${p.name}${p.tags && p.tags.length ? ' ' + p.tags.join('/') : ''}${p.unit ? ` (${p.unit})` : ''}${p.partial ? p.partial.mark : ''}`;
    const lines = s => String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const eventNotes = r => [...lines(r.requirement), ...((r.derived && r.derived.notes) || []), ...lines(r.notes)].join('\n');
    function rowCells(r) {
      const names = role => (r.people || []).filter(p => p.role === role).map(formatName).join('\n');
      return [r.title, r.dateLabel, r.meetSJ, r.meetEvent, r.approxEnd, r.location, r.coordinator, eventNotes(r), names('MFR'), names('Apprentice'), lines(r.equipment).join('\n'), lines(r.vehicle).join('\n')].map(v => String(v ?? ''));
    }
    // Header first, a blank spacer between dates like the sheet, cells with
    // line breaks quoted so Excel and Sheets keep them in one cell.
    function toWorkbookRows(rows, { spacers = true } = {}) {
      const out = [COLUMNS.slice()], colours = ['']; let prev = null;
      (rows || []).forEach(r => {
        if (spacers && prev && prev !== r.date) { out.push(COLUMNS.map(() => '')); colours.push(''); }
        out.push(rowCells(r)); colours.push(r.colour || ''); prev = r.date;
      });
      return { rows: out, colours };
    }
    const tsvCell = v => /[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const toTSV = (rows, opts) => toWorkbookRows(rows, opts).rows.map(r => r.map(tsvCell).join('\t')).join('\n');

    // --- .xlsx. The SheetJS community build writes cells but drops every
    // style, and the fills are the one thing this sheet actually relies on.
    // An xlsx is a zip of a few XML files, so this writes them directly
    // (stored, no compression - a month is a few KB).
    const WIDTHS = [28, 11, 9, 9, 9, 24, 18, 36, 26, 20, 12, 12];
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
      const { rows: aoa, colours } = toWorkbookRows(rows);
      const name = String(sheetName).replace(/[\[\]:*?\/\\]/g, '').slice(0, 31) || 'Schedule';
      const styleOf = (ri, hex) => ri === 0 ? 1 : hex ? 2 + COLOURS.findIndex(c => c.hex === hex) : 0;
      const sheetRows = aoa.map((cells, ri) => {
        const s = styleOf(ri, colours[ri]);
        const nLines = Math.max(1, ...cells.map((v, ci) => lines(v).reduce((a, l) => a + Math.max(1, Math.ceil(l.length / WIDTHS[ci])), 0)));
        const cs = cells.map((v, ci) => v === '' ? (s ? `<c r="${colRef(ci)}${ri + 1}" s="${s}"/>` : '') : `<c r="${colRef(ci)}${ri + 1}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`).join('');
        return `<row r="${ri + 1}" ht="${15 * nLines + 3}" customHeight="1">${cs}</row>`;
      }).join('');
      const xml = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
      const sheet = xml(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${colRef(COLUMNS.length - 1)}${aoa.length}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${WIDTHS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${sheetRows}</sheetData><pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`);
      const fills = COLOURS.map(c => `<fill><patternFill patternType="solid"><fgColor rgb="FF${c.hex.slice(1)}"/><bgColor indexed="64"/></patternFill></fill>`).join('');
      const align = '<alignment vertical="top" wrapText="1"/>';
      const xfs = [`<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1">${align}</xf>`, `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">${align}</xf>`, ...COLOURS.map((c, i) => `<xf numFmtId="0" fontId="0" fillId="${i + 2}" borderId="0" xfId="0" applyFill="1" applyAlignment="1">${align}</xf>`)];
      const styles = xml(`<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="${COLOURS.length + 2}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fills}</fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
      return zipStored([
        { name: '[Content_Types].xml', text: xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>') },
        { name: '_rels/.rels', text: xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
        { name: 'xl/workbook.xml', text: xml(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
        { name: 'xl/_rels/workbook.xml.rels', text: xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') },
        { name: 'xl/styles.xml', text: styles },
        { name: 'xl/worksheets/sheet1.xml', text: sheet },
      ]);
    }

    return { COLUMNS, COLOURS, TAGS, FIELDS, monthRows, eventRows, deriveDay, withOverrides, memberInfo, autoRole, formatName, eventNotes, rowCells, toTSV, toWorkbookRows, toXLSX, ymd, hm, dayLabel, today, monthName, monthLabel };
  })();
  D.Schedule = Schedule;
