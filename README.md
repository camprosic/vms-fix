# vms-fix

A Tampermonkey userscript that puts an actually useful frontend on the national VMS portal. It runs on the portal page
as whoever is signed in, so it only ever shows what that person's VMS role already lets them see. The one thing it
writes is shift approvals on the Hours tab, through the same approval form the portal uses, after you've confirmed the
list of exactly what will change.

Built for D0007 Hamilton but others are welcome to use it - just be sure to change the "GROUP_ID" global variable. Hope
it's helpful.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in any browser
2. Open this link. Tampermonkey will show the script and an **Install** button:

   https://raw.githubusercontent.com/camprosic/vms-fix/main/d0007-ops.user.js

3. Sign in to https://volunteer-sja.powerappsportals.com as normal.
4. There's now a green **VMS** button bottom-right on every portal page. Click it (or add `#d0007` to any portal URL).
   `Esc` closes it.

Updates: the script header has `@updateURL` / `@downloadURL` pointing back at this repo, so Tampermonkey picks up new
versions on its own. Bump `@version` and push to `main` to release.

Chrome 138+ note: if Tampermonkey complains that userscripts are blocked, turn on **Developer mode** on
`chrome://extensions`.

## What's in it

| Tab | Shows | Source |
|---|---|---|
| Events | Upcoming / current / past / ad hoc events for the group with date, location, status, required quals and a staffing bar (signed up vs minimum, "N still needed"). "Who's on it" expands the sign-up list and reported shifts. | Group Lead > Events subgrids, `get-engagements`, event-summary subgrids |
| Schedule | The monthly event schedule in the same 12-column layout as the unit's spreadsheet: one row per event day, meet/end times from the day's main shift, names split into MFR / Apprentice with C / D / Sr tags, other-unit labels and `*` partial-shift markers (with the matching `**16:30 to End` note), plus the unit-side columns VMS doesn't have (Meet @ St.John, coordinator, notes, requirement, equipment, vehicle, row colour) editable in place. Copy the month as spreadsheet rows, download it as .xlsx, or print it. | Events + event-summary subgrids, `Store` for the unit-side columns |
| Roster | All group members with email, phone, status, contact id and effective schedule role. Search. Click a member for their 12-month hours and certs, and to set their schedule tags (MFR/Apprentice, C/D/Sr, unit). CSV download. | `volunteers-by-group-csv-feed`, `Store` for tags |
| Hours | **Pending approvals**: every reported shift waiting on a group lead, grouped by event, with hours / status / times editable per row or per event, a confirmation list, and a per-shift result. Below it (collapsed), completed vs pending hours by volunteer or by event, 12 months / 90 days / 30 days. Sortable. CSV download. | Group Lead → Hours page, the shift approval entity form, `participation-reports-csv-feed` |
| Certifications | Every cert VMS will report, flagged Expired / Expiring in 90 days / Current / No expiry. Filter by status, member or qualification. CSV download. | `qualifications-gained-csv-feed` + `verified-qualifications-csv-feed` |
| Data | Export / import / reset the unit-side data (schedule edits, member tags) as a JSON file so it can be passed between people. | localStorage |

## How it gets the data

All of it is plain same-origin `fetch` with the browser's existing session cookie. No scraping of the rendered UI, no
clicking through pages.

- **Subgrid endpoint** - `POST /_services/entity-subgrid-data.json/<site-id>`. The Group Lead pages host standard
  Power Pages entity subgrids; each grid's `data-view-layouts` attribute has a `Base64SecureConfiguration` that the
  endpoint accepts along with the antiforgery token from `/_layout/tokenhtml`. Response is
  `{Records[{Id, Attributes[{Name, Value, DisplayValue, Type}]}], MoreRecords, ItemCount}`. Dates arrive as
  `/Date(ms)/` in `Value` and ISO in `DisplayValue`. Used for the event lists and, per event, the participations and
  participation-schedule grids on `/group-lead/event-summary/?eventid=...`.
- **`/en-US/get-engagements/`** - JSON list of upcoming published events with `NumVols` (signed up) and `MinVols`
  (minimum). Its `OppId` is the public engagement opportunity id; `/_api/msnfp_publicengagementopportunities` maps
  that to the real event id.
- **CSV feeds** under `/group-lead/*-csv-feed?fetchReport=<window>&groupId=<group>` for roster, hours and certs.
  Heads up: the cert report codes don't mean what the menu labels say. From the FetchXML on the pages:
  `last12months` = expiry in last 12 months, `next90days` = expiry in next 90 days, `nextYear` = expiry next
  calendar year, `last90days` = effective date this year, `last30days` = effective date last year. The script pulls
  all five and de-dupes.

Results are cached in memory until you hit Refresh.

## The event schedule

VMS knows the event, where it is, who booked which shift and when. The spreadsheet the unit actually runs on adds
things VMS has no field for: when to meet at the branch, who's coordinating on site, kit and vehicle numbers, the
staffing requirement, and who's Command / Driver / Sr versus Apprentice. The Schedule tab derives everything it can
from VMS (one row per event day, the main shift window, who's on it, who's on a partial shift) and stores the rest in
the browser's localStorage under `camsvms.v1`. That means edits live on the machine where you made them - use the Data
tab to export them as a file and import on another one. Roles default to Apprentice unless VMS has a current Medical
First Responder certification on file for the person; override per member from the Roster tab.

Rows are keyed by event id and date, so they survive VMS renaming or re-timing the event. Past events older than
about six weeks aren't opened (that's one page read per event), so the month view is forward-looking by design.

## Approving hours

This is the only write. It does what you'd do by hand on Group Lead → Hours, without the one-modal-per-shift part:

- The pending list is read off the Hours page (`/group-lead/hours/?groupid=…&fetchPage=n`), which renders its table
  from inline JS, one block per shift. Ten a page, so a backlog of 143 is fifteen reads.
- Each shift's approval form (`/_portal/modal-form-template-path/…?id=<shift>&entityformid=…`, a Power Pages entity
  form over `msnfp_participationschedule`) is read when you first touch the row, so the start, end and hours on screen
  are the record's own values, not the list's.
- Submit shows the full list of changes; Confirm then loads each form in a hidden iframe, sets the same four fields
  (`sjavms_start`, `sjavms_end`, `sjavms_hours`, `msnfp_schedulestatus`) and clicks the form's own Submit button, so
  the portal's validators and WebForms postback run exactly as they do in the modal. Success is the same
  "Submission completed successfully." the portal's modal code waits for; anything else is shown on the row.
- One shift at a time, in order. A failure doesn't stop the rest. The pending list is re-read afterwards.

An approved shift can't be put back to pending from this screen. If you need that, it's the record in VMS.

## Why a userscript

The portal session is a same-origin cookie and the `Access-Control-Allow-Origin` header only allows the B2C login
host, so nothing hosted elsewhere can read VMS. Anything that wants the data without backend changes has to run on
the portal's own origin. The portal doesn't send a Content-Security-Policy, so an injected script is fine. The
Power Pages web api (`/_api/`) used to expose a lot more and got cut right back in October 2026, which is why the
script leans on the Liquid pages, csv feeds and the subgrid endpoint instead - those are what the portal's own UI
runs on, so they're much less likely to be switched off.

## Known limits

- Schedule edits and member tags are per browser (localStorage). Export from the Data tab before clearing site data or switching machines.
- Certs gained more than two years ago that expire after next year don't show up in any VMS report window.
- Past events list is capped at the 200 most recent.
- Members are matched across feeds by name (the csv feeds don't carry contact ids consistently), so a renamed or
  duplicated contact can split.
- The Liquid pages and csv feeds are specific to this portal and can change without warning when national updates
  it. The subgrid endpoint is standard Power Pages and should be more stable.

## Data handling

Roster and cert feeds contain personal info. The script keeps everything in page memory, writes nothing to disk unless
you press a Download CSV button, and only shows what the signed-in user can already see in the portal. Treat the CSVs
like any other VMS export.
