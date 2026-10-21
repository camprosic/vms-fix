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
| Schedule | The month's events in the same layout as the unit's event-schedule spreadsheet, built only from what VMS holds: one row per event day; the VMS shift start as "Meet @ St.John" and the shift end as "Approx. End"; each shift definition with booked/max; location and street address; the organizer's on-site contact (phone, email) when VMS still shows it; who's booked, split into Medical First Responders and Apprentice by the shift they booked, with `*` partial-shift markers; required qualifications. Copy the month as spreadsheet rows (the sheet's 12 columns, VMS-less ones left blank), download it as .xlsx, or print it. | Events + event-summary subgrids, the public event page, the web api address columns, the pending-request form |
| Roster | All group members with email, phone, status, contact id and whether VMS has a current Medical First Responder certification on file. Search. Click a member for their 12-month hours and certs. CSV download. | `volunteers-by-group-csv-feed`, `qualifications-gained-csv-feed` |
| Hours | **Pending approvals**: every reported shift waiting on a group lead, grouped by event, with hours / status / times editable per row or per event, a confirmation list, and a per-shift result. Below it (collapsed), completed vs pending hours by volunteer or by event, 12 months / 90 days / 30 days. Sortable. CSV download. | Group Lead → Hours page, the shift approval entity form, `participation-reports-csv-feed` |
| Certifications | Every cert VMS will report, flagged Expired / Expiring in 90 days / Current / No expiry. Filter by status, member or qualification. CSV download. | `qualifications-gained-csv-feed` + `verified-qualifications-csv-feed` |

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

The unit runs on a monthly spreadsheet (Event / Date / Meet @ St.John / Meet @ Event / Approx. End / Location /
On-Site Coordinator / Event Notes / Medical First Responders / Apprentice / Equipment / Vehicle). The Schedule tab
shows everything VMS can contribute to that, in that shape, so the person keeping the sheet can lift it across in one
go. It does not store or invent anything: the columns VMS has nothing for (Meet @ Event, equipment, vehicle, the
notes) are left blank in the export for the volunteer to fill in.

Where each column comes from:

- Rows are one per event day. Days come from the event's shift definitions on the public event page
  (`/engagement/?id=<public id>`), whose rows carry the shift name, start, end, max and booked counts.
- **Meet @ St.John** is the earliest shift start that day (that's how the unit uses it); **Approx. End** the latest shift end.
- **Location** is the event's location name plus the street address from `/_api/msnfp_engagementopportunities` (one of
  the few columns the web api still exposes).
- **On-Site Coordinator** comes from the event *request* form (`/group-lead/event-general/?id=…`), which carries the
  organizer and an on-site contact with phone and email. VMS only lists requests while they're waiting for the group
  lead's approval, so for an already-approved event the column says so instead. (That's a VMS gap worth raising with
  national: the one phone number you need on the day is hidden once the event is approved.)
- **Medical First Responders / Apprentice** are the people booked on that day, split by the shift they booked
  ("MFR" or "Apprentice" — every D0007 event defines exactly those two). The booked shift is only visible through the
  booking's approval form, so the tab first splits by whether VMS has a current MFR certification for the person,
  compares those counts with the shifts' booked counts, and only reads the forms for days where they disagree.
  Someone whose booked window differs from the shift gets a `*` and a "**16:30 to End" note, like the sheet.

## Known limits (schedule)

- Past events older than about six weeks aren't opened (one page read per event).
- Reading booked shift types is one request per booking; a month with a big multi-day fair can take a minute the
  first time. Results are kept for the session.

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
