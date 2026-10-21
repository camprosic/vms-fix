# src/

The userscript is built by concatenating these files in name order (`node build.js` → `../d0007-ops.user.js`).
Everything lives inside one IIFE, so a `const` declared in an earlier file is visible to later ones.

| File | What's in it |
|---|---|
| `00-header.js` | Userscript header, config (`GROUP_ID`, `SITE_ID`, `TZ`, `CERT_WARN_DAYS`), helpers (`esc`, `el`, `toDate`, `fmtDT`, `fmtD`, `num`, `r2`, `norm`, `daysUntil`, `decodeEntities`, `parseCSV`), the `D` registry and the `TABS` list |
| `10-store.js` | `Store` — localStorage-backed unit-side data with export/import. Sections: `schedule`, `members`, `settings` |
| `20-vms.js` | `VMS` — read-only data layer. `upcomingEngagements()`, `groupEvents()`, `eventDetail(id)`, `roster()`, `hours(win)`, `certifications()`, `clear()`. Internals: `getToken()`, `getDoc()`, `getText()`, `gridsIn(doc)`, `subgridRows(grid, opts)`, `flatten(record)` |
| `21-schedule.js` | `Schedule` — the monthly Event Schedule rows: `monthRows(year, month)` (VMS events + shifts, one row per event day, `Store` overrides merged), `deriveDay(shifts)`, `memberInfo(name, {certs, members})`, `withOverrides(row)`, `formatName(p)`, `toTSV(rows)`, `toWorkbookRows(rows)`, `toXLSX(rows, {sheetName})` (writes the .xlsx itself; no library) |
| `22-approve.js` | `Approvals` — the only writes. `pending()` walks Group Lead → Hours, `loadForm(shiftId)` reads a shift's approval form, `plan(form, changes)` works out start/end/hours/status and refuses bad combinations, `submit(shiftId, values)` posts the form (`drivers.iframe` by default, `drivers.fetch` for tests), `run(items)` does them one at a time and clears the VMS caches. `STATUS`, `toCrmIso`/`fromCrmIso`, `toLocalInput`/`fromLocalInput` |
| `30-styles.js` | Base CSS, scoped under `#d0007-root`. Screens push their own rules onto `CSS_PARTS` instead of editing it |
| `40-ui-core.js` | `state`, `root`/`main`, `pill()`, `statusPill()`, `sortRows()`, `th()`, `bindSort()`, `matches()`, `render()` |
| `5x-view-*.js` | One screen per file. Each ends with `TABS.push({ id, label, render })`. `51-view-schedule.js` is the Schedule tab (inline edits go to `Store.schedule`, keyed `eventId|YYYY-MM-DD`), `52-view-roster.js` also holds the member tag form (`Store.members`, keyed `norm(name)`), `56-view-data.js` is export/import/reset for `Store` |
| `60-shell.js` | `downloadCSV()`, `addStyles()`, `open()`, `close()` |
| `90-footer.js` | Exposes `window.D0007`, adds the launcher button and the Tampermonkey menu entry |

## Conventions

- A new screen is a new `5x-view-name.js` that defines `async function renderName()` writing into `main`, and pushes itself onto `TABS`. Nothing else needs editing.
- A new data module goes in `2x-name.js` and registers on `D` (`D.Schedule = Schedule`) so it's reachable from the console as `D0007.Schedule` and from tests.
- Everything the user sees is escaped with `esc()`. Build HTML with template strings, then bind events with `querySelectorAll` after assigning `innerHTML`.
- Dates: VMS gives `/Date(ms)/` from the grid endpoint, ISO from `DisplayValue`, `YYYY/MM/DD` from csv feeds. `toDate()` handles all three. Display in Eastern with `fmtDT`/`fmtD`.
- Members are matched across feeds by name (`norm(name)`), because the feeds don't carry ids consistently.
- Reads are cached in `VMS` until Refresh. Anything that writes to VMS must `VMS.clear()` the affected caches afterwards and must be explicit in the UI about what it is about to change.
- Keep the mocked portal in `test/run.js` in step with any new VMS route you add, and add a `test/*.test.js` for new modules. `npm test` builds and runs.
