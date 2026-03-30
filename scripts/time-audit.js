#!/usr/bin/env node
/**
 * Time audit script: cross-references calendar billable hours with
 * Jira ticket IDs found in event titles to produce a per-ticket
 * time breakdown.
 *
 * Reads from the latest calendar-audit scrape and produces a JSON
 * audit report that can be consumed by the companion Claude Code
 * skill for enrichment with Jira/GitHub data.
 *
 * Usage:
 *   node scripts/time-audit.js --match "Great Grants" --from 2026-03-01 --to 2026-03-29
 *   node scripts/time-audit.js --match "Great Grants" --weeks 2
 *   node scripts/time-audit.js --calendar-id billable --match "Acme" --jira-prefix TP
 */

import path from "node:path";
import fs from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  differenceInMilliseconds,
  format,
  formatISO,
  parseISO,
  subWeeks,
  startOfDay,
  endOfDay,
} from "date-fns";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, ".data", "calendar-audit");

function loadEnv() {
  const envLocal = path.join(ROOT, ".env.local");
  const envDefault = path.join(ROOT, ".env");
  if (fs.existsSync(envLocal)) {
    dotenv.config({ path: envLocal });
    return;
  }
  if (fs.existsSync(envDefault)) {
    dotenv.config({ path: envDefault });
  }
}

function csvEscape(value) {
  const str = value == null ? "" : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function pickLatestDateDir(calendarDir) {
  const entries = await readdir(calendarDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .sort()
    .reverse()[0];
}

async function findCalendarDir(calendarIdOrName) {
  const entries = await readdir(DATA_DIR, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  // Exact match first
  if (dirs.includes(calendarIdOrName)) return calendarIdOrName;

  // Substring match on directory name
  const matches = dirs.filter((d) =>
    d.toLowerCase().includes(calendarIdOrName.toLowerCase()),
  );
  if (matches.length === 1) return matches[0];

  // Search metadata in latest events.json for calendar name
  for (const dir of dirs) {
    const dateDir = await pickLatestDateDir(path.join(DATA_DIR, dir));
    if (!dateDir) continue;
    const eventsPath = path.join(DATA_DIR, dir, dateDir, "events.json");
    try {
      const raw = await readFile(eventsPath, "utf-8");
      const data = JSON.parse(raw);
      const calName = data.metadata?.calendarName ?? "";
      if (calName.toLowerCase().includes(calendarIdOrName.toLowerCase())) {
        return dir;
      }
    } catch {
      continue;
    }
  }

  if (matches.length > 1) {
    throw new Error(
      `Ambiguous calendar match for "${calendarIdOrName}": ${matches.join(", ")}`,
    );
  }
  throw new Error(
    `No calendar data found matching "${calendarIdOrName}". Available: ${dirs.join(", ")}`,
  );
}

function parseEventDate(value) {
  if (!value) return null;
  try {
    return parseISO(value);
  } catch {
    return null;
  }
}

function eventHours(event) {
  const start = parseEventDate(event.start);
  const end = parseEventDate(event.end);
  if (!start || !end) return 0;
  const ms = differenceInMilliseconds(end, start);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return ms / (1000 * 60 * 60);
}

function stripMarkup(text) {
  return text
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTicketIds(text, prefix) {
  if (!text || !prefix) return [];
  const pattern = new RegExp(`${prefix}-(\\d+)`, "gi");
  const matches = [...text.matchAll(pattern)];
  return [...new Set(matches.map((m) => `${prefix.toUpperCase()}-${m[1]}`))];
}

function matchesAny(text, patterns) {
  if (!text || !patterns.length) return false;
  const lower = text.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}

async function main() {
  loadEnv();

  const argv = await yargs(hideBin(process.argv))
    .option("calendar-id", {
      type: "string",
      describe:
        "Calendar ID, directory name, or name substring to search in .data/calendar-audit",
      default: "billable",
    })
    .option("date", {
      type: "string",
      describe: "Date directory (YYYY-MM-DD); defaults to latest available",
    })
    .option("from", {
      type: "string",
      describe: "Start date inclusive (YYYY-MM-DD or ISO string)",
    })
    .option("to", {
      type: "string",
      describe: "End date inclusive (YYYY-MM-DD or ISO string)",
    })
    .option("weeks", {
      type: "number",
      describe:
        "Look back N weeks from today (alternative to --from/--to). Ends at yesterday.",
      default: 2,
    })
    .option("match", {
      type: "string",
      array: true,
      describe:
        "Case-insensitive substrings to match in event titles (matches any)",
      demandOption: true,
    })
    .option("jira-prefix", {
      type: "string",
      describe: "Jira ticket prefix to extract from event titles (e.g. TP, GG)",
    })
    .option("out", {
      type: "string",
      describe: "Output path for the JSON audit report",
    })
    .option("csv", {
      type: "string",
      describe: "Also write a CSV summary to this path",
    })
    .option("format", {
      type: "string",
      choices: ["json", "table", "both"],
      default: "both",
      describe: "Output format",
    })
    .help()
    .parse();

  // Resolve calendar directory
  const calendarDirName = await findCalendarDir(argv["calendar-id"]);
  const calendarDir = path.join(DATA_DIR, calendarDirName);

  const dateDir =
    argv.date ||
    (await pickLatestDateDir(calendarDir)) ||
    (() => {
      throw new Error(`No dated audit directories found in ${calendarDir}`);
    })();

  const eventsPath = path.join(calendarDir, dateDir, "events.json");
  const raw = await readFile(eventsPath, "utf-8");
  const data = JSON.parse(raw);
  const allEvents = data.events ?? [];

  // Resolve date range
  const now = new Date();
  let from, to;
  if (argv.from) {
    from = startOfDay(
      parseISO(
        argv.from.length === 10 ? `${argv.from}T00:00:00` : argv.from,
      ),
    );
  } else {
    from = startOfDay(subWeeks(now, argv.weeks));
  }
  if (argv.to) {
    to = endOfDay(
      parseISO(argv.to.length === 10 ? `${argv.to}T23:59:59` : argv.to),
    );
  } else {
    // Default to yesterday end-of-day
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    to = endOfDay(yesterday);
  }

  const matchPatterns = argv.match;
  const jiraPrefix = argv["jira-prefix"];

  // Filter events
  const matched = [];
  for (const event of allEvents) {
    const start = parseEventDate(event.start);
    if (!start || start < from || start > to) continue;

    const fullText = `${event.summary ?? ""} ${event.description ?? ""}`;
    if (!matchesAny(fullText, matchPatterns)) continue;

    const hours = eventHours(event);
    const tickets = jiraPrefix ? extractTicketIds(fullText, jiraPrefix) : [];

    matched.push({
      date: format(start, "yyyy-MM-dd"),
      summary: event.summary ?? "",
      description: stripMarkup(event.description ?? "").slice(0, 200),
      start: event.start,
      end: event.end,
      hours: Math.round(hours * 100) / 100,
      tickets,
    });
  }

  // Aggregate by ticket
  const byTicket = {};
  const untagged = [];
  let totalHours = 0;

  for (const entry of matched) {
    totalHours += entry.hours;
    if (entry.tickets.length > 0) {
      for (const ticket of entry.tickets) {
        if (!byTicket[ticket]) byTicket[ticket] = { hours: 0, entries: [] };
        // Split hours evenly if multiple tickets in one event
        const share = entry.hours / entry.tickets.length;
        byTicket[ticket].hours += share;
        byTicket[ticket].entries.push({
          date: entry.date,
          hours: Math.round(share * 100) / 100,
          summary: entry.summary,
        });
      }
    } else {
      untagged.push(entry);
    }
  }

  // Aggregate untagged by date
  const untaggedByDate = {};
  for (const entry of untagged) {
    if (!untaggedByDate[entry.date]) {
      untaggedByDate[entry.date] = { hours: 0, entries: [] };
    }
    untaggedByDate[entry.date].hours += entry.hours;
    untaggedByDate[entry.date].entries.push({
      hours: entry.hours,
      summary: entry.summary,
    });
  }

  // Build report
  const report = {
    metadata: {
      calendarId: calendarDirName,
      calendarName: data.metadata?.calendarName ?? calendarDirName,
      scrapedAt: data.metadata?.fetchedAt ?? dateDir,
      dateRange: {
        from: formatISO(from, { representation: "date" }),
        to: formatISO(to, { representation: "date" }),
      },
      matchPatterns,
      jiraPrefix: jiraPrefix ?? null,
      totalEvents: matched.length,
      totalHours: Math.round(totalHours * 100) / 100,
    },
    ticketHours: Object.entries(byTicket)
      .map(([ticket, data]) => ({
        ticket,
        hours: Math.round(data.hours * 100) / 100,
        entries: data.entries,
      }))
      .sort((a, b) => b.hours - a.hours),
    untaggedHours: {
      totalHours: Math.round(
        untagged.reduce((s, e) => s + e.hours, 0) * 100,
      ) / 100,
      byDate: Object.entries(untaggedByDate)
        .map(([date, data]) => ({
          date,
          hours: Math.round(data.hours * 100) / 100,
          entries: data.entries,
        }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    },
    allEntries: matched,
  };

  // Output
  const jsonStr = JSON.stringify(report, null, 2);

  if (argv.out) {
    const outPath = path.isAbsolute(argv.out)
      ? argv.out
      : path.join(ROOT, argv.out);
    await writeFile(outPath, jsonStr);
    console.log(`📄 JSON report: ${outPath}`);
  }

  if (argv.csv) {
    const csvPath = path.isAbsolute(argv.csv)
      ? argv.csv
      : path.join(ROOT, argv.csv);
    const csvRows = [
      ["date", "ticket", "summary", "hours"].join(","),
      ...matched.map((e) =>
        [
          csvEscape(e.date),
          csvEscape(e.tickets.join("; ") || "untagged"),
          csvEscape(e.summary),
          e.hours.toFixed(2),
        ].join(","),
      ),
    ];
    await writeFile(csvPath, csvRows.join("\n"));
    console.log(`📄 CSV report: ${csvPath}`);
  }

  if (argv.format === "table" || argv.format === "both") {
    console.log(
      `\n🕐 Time Audit: ${report.metadata.calendarName} (${report.metadata.dateRange.from} → ${report.metadata.dateRange.to})`,
    );
    console.log(`   ${report.metadata.totalEvents} events, ${report.metadata.totalHours} hours total\n`);

    if (report.ticketHours.length > 0) {
      console.log("Ticket-Tagged Hours:");
      console.log("  Ticket          Hours  Dates");
      console.log("  ──────────────  ─────  ─────");
      for (const t of report.ticketHours) {
        const dates = [...new Set(t.entries.map((e) => e.date))].join(", ");
        console.log(
          `  ${t.ticket.padEnd(16)} ${t.hours.toFixed(2).padStart(5)}  ${dates}`,
        );
      }
      console.log(
        `  ${"SUBTOTAL".padEnd(16)} ${report.ticketHours.reduce((s, t) => s + t.hours, 0).toFixed(2).padStart(5)}`,
      );
    }

    if (report.untaggedHours.totalHours > 0) {
      console.log(`\nUntagged Hours (${report.untaggedHours.totalHours} hrs):`);
      console.log("  Date        Hours  Events");
      console.log("  ──────────  ─────  ──────");
      for (const d of report.untaggedHours.byDate) {
        const summaries = d.entries.map((e) => e.summary).join("; ");
        console.log(
          `  ${d.date}  ${d.hours.toFixed(2).padStart(5)}  ${summaries.slice(0, 80)}`,
        );
      }
    }
  }

  if (argv.format === "json" || argv.format === "both") {
    if (!argv.out) {
      // If no file output specified, print JSON to stdout
      if (argv.format === "json") {
        console.log(jsonStr);
      }
    }
  }

  return report;
}

main().catch((err) => {
  console.error("time-audit failed:", err.message);
  process.exitCode = 1;
});
