# Calendar Audit Script Proposal

This document proposes a `pnpm run calendar:scrape` script that exports the last 90 days of events from a private Google Calendar (e.g., `<patrick@pstaylor.net>`) into a structured JSON file saved locally under a gitignored `.data/` directory. The design follows Google Calendar API guidance for installed apps (desktop) using the official Node client.

## Goals

- Pull private calendar data securely without committing secrets or data.
- Keep the workflow simple: `pnpm run calendar:scrape -- --calendar "<name-or-id>"`.
- Produce deterministic, structured JSON for downstream analysis.

## High-Level Flow

1. Resolve which calendar to audit via user input (ID preferred; fallback to name match via Calendar API list).
2. Authenticate to Google Calendar API using OAuth client credentials stored locally (no secrets in git).
3. Fetch events in the range `[today-90d, today]`, handling pagination.
4. Normalize events into a stable JSON schema.
5. Write results to `.data/calendar-audit/<calendar-id>/<YYYY-MM-DD>/events.json`.

## Inputs and Configuration

- `--calendar`: required; accepts calendar ID (recommended) or name substring to match (resolved via Calendar List).
- `--days`: optional; default `90` (no flag required). Env override: `CALENDAR_AUDIT_DAYS`.
- `--out-dir`: optional; default `.data/calendar-audit`.
- Environment:
  - Optional `GOOGLE_CALENDAR_ID` or `CALENDAR_AUDIT_CALENDAR` to skip CLI flag.
  - OAuth client and token files stored locally under `.data/` (see Authentication).

## Authentication

- Use OAuth2 installed-app flow via `@google-cloud/local-auth` + `googleapis` (same as the Google Calendar Node quickstart).
- Required scope: `https://www.googleapis.com/auth/calendar.readonly`.
- Place downloaded desktop-app credentials JSON (from Google Cloud console) at `.data/credentials.json`.
  - Enable the Calendar API on the project and configure the OAuth consent screen (Internal is fine for personal use).
  - Auth client type: Desktop app.
- Token caching: `.data/token.json` (created on first run after browser consent).
- Secrets and tokens never leave the machine; `.data/` is gitignored.
- Optional: the script will generate `.data/credentials.json` automatically if `GOOGLE_CLIENT_SECRET_JSON` (or `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`) is present in your `.env.local`/`.env`.

## Calendar API touchpoints (per API overview)

- **CalendarList**: enumerate calendars visible to the user to resolve the requested calendar by ID or name substring.
- **Calendar**: metadata (name, time zone) for selected calendar; used for output metadata.
- **Event**: primary resource retrieved via `calendar.events.list` with `timeMin/timeMax`, `singleEvents: true`, `orderBy: 'startTime'`.
- **ACL/Setting**: not mutated; only user-level read access required.

## Data Shape (example)

```json
{
  "metadata": {
    "calendarId": "primary",
    "calendarName": "Personal",
    "fetchedAt": "2024-12-08T17:00:00Z",
    "windowStart": "2024-09-09T00:00:00Z",
    "windowEnd": "2024-12-08T23:59:59Z",
    "eventCount": 123
  },
  "events": [
    {
      "id": "evt_123",
      "status": "confirmed",
      "summary": "Lunch",
      "description": "with Sam",
      "location": "Local Cafe",
      "start": "2024-12-01T12:00:00-05:00",
      "end": "2024-12-01T13:00:00-05:00",
      "created": "2024-11-20T10:15:00-05:00",
      "updated": "2024-11-21T08:30:00-05:00",
      "hangoutLink": null,
      "attendees": [
        {
          "email": "patrick@pstaylor.net",
          "responseStatus": "accepted",
          "self": true
        }
      ],
      "recurringEventId": null,
      "iCalUID": "evt_123@google.com",
      "raw": { "etag": "\"abcdef\"" }
    }
  ]
}
```

`raw` retains non-modeled fields for debugging while keeping the primary object stable for consumers.

## Error Handling and Observability

- Detect ambiguous calendar name matches and exit with a clear message listing candidates.
- Retry transient Calendar API errors with backoff.
- Count and log pagination pages and total events fetched.
- Validate write path exists; create directories as needed.
- Log which calendar was resolved (ID + summary) and the effective time window.

## Implementation Plan

- Add script: `"calendar:scrape": "node scripts/calendar-audit.js"` to `package.json`.
- Add dependencies: `googleapis@^105`, `@google-cloud/local-auth@^2.1.0`, `yargs` (or `commander`), `date-fns` for date math.
- Implement `scripts/calendar-audit.js`:
  - Parse args/env.
  - Bootstrap OAuth via `authenticate()` with scope `calendar.readonly`, keyfile `.data/credentials.json`, token cache `.data/token.json`.
  - Resolve calendar via `calendar.calendarList.list()` when a name was provided; prefer ID if passed.
  - Fetch events via `calendar.events.list()` with `timeMin/timeMax`, `singleEvents: true`, `orderBy: 'startTime'`, paging until done.
  - Normalize events into the documented schema; carry selected raw fields under `raw`.
  - Write JSON to `.data/calendar-audit/<calendar-id>/<YYYY-MM-DD>/events.json` (mkdir -p as needed).
- Document usage in `README` once implemented.

## Usage (future)

```bash
pnpm run calendar:scrape -- --calendar "primary"
# or
pnpm run calendar:scrape -- --calendar "Personal"
```

## Setup Checklist (Google Cloud + Local)

- Enable Google Calendar API in your Google Cloud project.
- Configure OAuth consent screen (Desktop app; Internal is fine for personal use).
- Create OAuth 2.0 Client ID (Desktop) and download JSON; save to `.data/credentials.json`.
- Ensure `.data/` stays gitignored (already configured).
- First run will open a browser for consent and cache token at `.data/token.json`.
- You may provide credentials via `.env.local` (`GOOGLE_CLIENT_SECRET_JSON` or `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`), and the script will write `.data/credentials.json` automatically.
