---
name: time-audit
description: Cross-reference calendar billable hours with Jira tickets and GitHub activity to produce a per-ticket time allocation for Jira time tracking updates
user_invocable: true
---

# Time Audit Skill

Cross-references Google Calendar billable hours with Jira and GitHub activity to produce actionable per-ticket time allocations.

## Workflow

### Step 1: Scrape fresh calendar data

Run the calendar scrape to get the latest events:

```bash
node scripts/calendar-audit.js --calendar "{{calendar}}" --days {{days}}
```

This may trigger an OAuth browser flow if the token is expired. If it hangs, tell the user to run it via `!` prefix in their terminal.

### Step 2: Run the time audit script

```bash
node scripts/time-audit.js \
  --calendar-id "{{calendar-id}}" \
  --match "{{match-pattern-1}}" --match "{{match-pattern-2}}" \
  --jira-prefix "{{jira-prefix}}" \
  --from "{{from-date}}" --to "{{to-date}}" \
  --format both \
  --out .data/time-audit-latest.json
```

The script produces:
- **Ticket-tagged hours**: Calendar events that explicitly mention a Jira ticket ID
- **Untagged hours**: Generic engineering time with no ticket reference

### Step 3: Enrich with GitHub data

Use the GitHub CLI to get commits and PR activity for the same date range:

```bash
gh api repos/{{owner}}/{{repo}}/commits --method GET \
  -f author={{github-username}} \
  -f since={{from-date}}T00:00:00Z \
  -f until={{to-date}}T23:59:59Z \
  -f per_page=100 \
  --jq '.[] | {date: .commit.author.date[0:10], message: .commit.message | split("\n")[0]}'

gh api repos/{{owner}}/{{repo}}/pulls --method GET \
  -f state=all -f per_page=50 -f sort=created -f direction=desc \
  --jq '.[] | select(.user.login == "{{github-username}}") | select(.created_at >= "{{from-date}}") | select(.created_at < "{{to-date}}") | {number: .number, created: .created_at[0:10], merged: (.merged_at // "open")[0:10], title: .title, branch: .head.ref}'
```

### Step 4: Enrich with Jira data

Use the Atlassian MCP to look up ticket details for any tickets found in the calendar or GitHub data:

1. Look up the user's Jira account ID:
   ```
   mcp__atlassian__lookupJiraAccountId(cloudId="{{jira-cloud-id}}", searchString="{{user-name}}")
   ```

2. Search for active tickets:
   ```
   mcp__atlassian__searchJiraIssuesUsingJql(
     cloudId="{{jira-cloud-id}}",
     jql='project = "{{jira-prefix}}" AND assignee = "{{account-id}}" AND updated >= -{{weeks}}w',
     fields=["summary", "status", "timetracking", "issuetype"]
   )
   ```

### Step 5: Allocate untagged hours

For each day of untagged engineering time:
1. Check which GitHub commits were made on that day
2. Check which PRs were actively being worked on (created before, not yet merged)
3. Map the day's hours to those tickets proportionally
4. Flag any days with no commit activity as "general engineering overhead"

### Step 6: Produce the audit report

Write a markdown report to the repo with:
- Per-ticket hours (direct + inferred)
- Comparison to Jira estimates
- Recommended `timeSpent` values to log in Jira
- Meeting/ceremony overhead summary

### Step 7 (Optional): Update Jira time tracking

If the user confirms, use the Atlassian MCP to:

1. **Log worklogs** for each ticket:
```
mcp__atlassian__addWorklogToJiraIssue(
  cloudId="{{jira-cloud-id}}",
  issueIdOrKey="{{ticket-key}}",
  timeSpent="{{time}}",
  started="{{iso-date}}",
  commentBody="Retroactive time log from calendar audit ({{date-range}})",
  contentFormat="markdown"
)
```

2. **Reconcile estimates** — update `originalEstimate` to match actual time spent and set `remainingEstimate` to `0h`:
```
mcp__atlassian__editJiraIssue(
  cloudId="{{jira-cloud-id}}",
  issueIdOrKey="{{ticket-key}}",
  fields={"timetracking": {"originalEstimate": "{{actual-time}}", "remainingEstimate": "0h"}}
)
```

This ensures Jira shows estimate = actual = logged, with 0h remaining. The rule is:
- `originalEstimate` gets retroactively updated to the real hours spent
- `remainingEstimate` is always 0h for completed work
- `timeSpent` comes from the worklog entries

3. **Open all tickets in browser** for manual audit:
```bash
open "https://{{jira-cloud-id}}/browse/{{ticket-key}}"
```

4. **Produce a clickable summary table** with markdown links to each ticket for spot-checking.

## Required Parameters

The user must provide or confirm:
- **calendar**: Google Calendar name or ID to scrape (e.g., "billable")
- **match**: One or more substrings to filter calendar events (e.g., "Great Grants", "Acme")
- **jira-prefix**: Jira project key prefix (e.g., "TP", "GG", "ACME")
- **jira-cloud-id**: Atlassian cloud site (e.g., "myorg.atlassian.net")
- **github-repo**: GitHub owner/repo (e.g., "myorg/my-project")
- **github-username**: GitHub username for commit/PR filtering
- **date-range**: --from / --to dates, or --weeks for a rolling window

## Notes

- The calendar scrape requires OAuth credentials in `.data/credentials.json`
- The script is project-agnostic: it works with any Jira project, GitHub repo, and Google Calendar
- Run weekly for best results; monthly retroactive audits require more inference
