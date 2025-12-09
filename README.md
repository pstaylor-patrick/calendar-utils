# Calendar Utils

CLI scripts for exporting and analyzing Google Calendar events.

## Scripts

- `pnpm calendar:scrape` — Fetch the last N days (default 90) of events from the configured calendar and write JSON under `.data/calendar-audit/<calendar-id>/<YYYY-MM-DD>/events.json`.
- `pnpm calendar:analyze` — Read the latest audit JSON and emit grouped hours by week to `calendar-hours.csv` and `calendar-hours.json` (both gitignored). Events are grouped by client categories defined in `clients.json`, then by title inside each client bucket.

## Configuration

Environment (set in `.env.local`):

- `GOOGLE_CALENDAR_ID` (or pass `--calendar`)
- `CALENDAR_AUDIT_DAYS` (optional override of 90)
- `GOOGLE_CLIENT_SECRET_JSON` (preferred) or `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
- Optional: `GOOGLE_REDIRECT_URIS` (comma-separated), `GOOGLE_PROJECT_ID`

First run prompts OAuth consent and caches a token in `.data/token.json`; credentials JSON is read from `.data/credentials.json` (auto-generated from env if missing).

## Usage

```bash
# Scrape events
pnpm calendar:scrape -- --calendar "<id-or-name>"

# Analyze latest scrape (weekly totals by title)
pnpm calendar:analyze
```

## Client grouping (`clients.json`)

Create a `clients.json` at repo root to map client names to alias keywords used for matching event titles. Start from the provided template:

```bash
cp clients.example.json clients.json
```

Then edit `clients.json` with your own categories and aliases. Example:

```json
{
  "Northwind Ventures": ["northwind", "nv"],
  "Beacon Outreach": ["beacon"],
  "Harper Nolan": ["harper", "hn"]
}
```

Rules:

- Matching is case-insensitive against event `summary`; aliases and the client key name are both used.
- Order matters: the first client whose key/aliases match an event claims it.
- Events with no match are grouped under `Other`.
- CSV output columns: `week_start, client, hours, count` (newest weeks first). CSV does not list individual event names.
- JSON output structure: `{ weeks: [{ weekStart, clients: [{ client, hours, count, summaries: [{ summary, hours, count }] }] }] }` and includes per-event-title rollups to help find missing keywords (e.g., items falling into `Other`).
