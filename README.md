# vms-fix

A Tampermonkey userscript that puts a D0007-shaped front end on the national VMS portal. Read-only for now. It runs on the
portal page as whoever is signed in, so it only ever shows what that person's VMS role already lets them see, and it
never writes anything back.

Built for St. John Ambulance Hamilton-Wentworth (D0007) MFR. Other groups could reuse it by changing `GROUP_ID` at the
top of the script.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome / Edge / Firefox / Safari.
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
| Roster | All group members with email, phone, status, contact id. Search. Click a member for their 12-month hours and certs. CSV download. | `volunteers-by-group-csv-feed` |
| Hours | Completed vs pending hours by volunteer or by event, 12 months / 90 days / 30 days. Sortable. CSV download. | `participation-reports-csv-feed` |
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
