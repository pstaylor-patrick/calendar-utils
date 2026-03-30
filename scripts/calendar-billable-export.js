#!/usr/bin/env node
/**
 * Export matching calendar events as a billable-hours CSV.
 *
 * Default input: latest date folder under
 *   .data/calendar-audit/<calendar-id>/YYYY-MM-DD/events.json
 * Default output: ./calendar-billable.csv
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
} from "date-fns";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, ".data", "calendar-audit");
const DEFAULT_CSV_OUT = path.join(ROOT, "reports", "calendar-billable.csv");
const DEFAULT_RATE = Number(process.env.BILLABLE_RATE) || 0;
const DEFAULT_MATCH = process.env.BILLABLE_MATCH || "";

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
  const dateDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .sort()
    .reverse();
  return dateDirs[0];
}

async function loadEvents(filePath) {
  const raw = await readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  return parsed.events ?? [];
}

function parseEventDate(value) {
  if (!value) return null;
  try {
    return parseISO(value);
  } catch {
    return null;
  }
}

function eventDurationHours(event) {
  const start = parseEventDate(event.start);
  const end = parseEventDate(event.end);
  if (!start || !end) return 0;
  const ms = differenceInMilliseconds(end, start);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return ms / (1000 * 60 * 60);
}

function clip(text, max = 160) {
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function stripMarkup(text) {
  return text
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<li>/gi, " ")
    .replace(/<\/li>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function summarizeDescription(description) {
  if (!description) return "";

  const cleaned = stripMarkup(description)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const lower = line.toLowerCase();
      return (
        !lower.startsWith("from:") &&
        !lower.startsWith("to:") &&
        !lower.startsWith("subject:") &&
        !lower.startsWith("cc:") &&
        !lower.startsWith("bcc:") &&
        !lower.startsWith("sent:") &&
        !lower.startsWith("meeting id:") &&
        !lower.startsWith("passcode:") &&
        !lower.startsWith("phone conference id:")
      );
    })
    .filter((line) => !/^https?:\/\/\S+$/i.test(line))
    .filter((line) => !/^\+?\d[\d\s,()-]+#?$/.test(line));

  const joined = cleaned.join(" ");
  return clip(
    joined
      .replace(/\*\*/g, "")
      .replace(/[#*_`>-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function matchesSummary(summary, match) {
  return (summary ?? "").toLowerCase().includes(match.toLowerCase());
}

function inDateRange(start, from, to) {
  if (!start) return false;
  return start >= from && start <= to;
}

function formatTimestamp(value) {
  return format(value, "yyyy-MM-dd HH:mm");
}

async function writeCsv({
  calendarId,
  dateDir,
  csvOut,
  from,
  to,
  match,
  rate,
}) {
  const eventsPath = path.join(DATA_DIR, calendarId, dateDir, "events.json");
  const events = await loadEvents(eventsPath);

  const rows = [
    [
      "event_title",
      "event_description_short",
      "start_time",
      "end_time",
      "duration_hours",
      "billable_rate_usd",
      "billable_amount_usd",
    ],
  ];

  let totalHours = 0;
  let totalAmount = 0;
  let matchedCount = 0;

  for (const event of events) {
    if (!matchesSummary(event.summary, match)) continue;

    const start = parseEventDate(event.start);
    const end = parseEventDate(event.end);
    if (!inDateRange(start, from, to) || !end) continue;

    const hours = eventDurationHours(event);
    const amount = hours * rate;
    matchedCount += 1;
    totalHours += hours;
    totalAmount += amount;

    rows.push([
      csvEscape(event.summary ?? ""),
      csvEscape(summarizeDescription(event.description)),
      csvEscape(formatTimestamp(start)),
      csvEscape(formatTimestamp(end)),
      hours.toFixed(2),
      rate.toFixed(2),
      amount.toFixed(2),
    ]);
  }

  rows.push([
    "TOTAL",
    "",
    "",
    "",
    totalHours.toFixed(2),
    rate.toFixed(2),
    totalAmount.toFixed(2),
  ]);

  const csv = rows.map((row) => row.join(",")).join("\n");
  await writeFile(csvOut, csv);

  return {
    matchedCount,
    totalHours,
    totalAmount,
    csvOut,
    dateDir,
    calendarId,
  };
}

async function main() {
  loadEnv();

  const argv = await yargs(hideBin(process.argv))
    .option("calendar-id", {
      type: "string",
      describe:
        "Calendar ID to read from .data/calendar-audit (default: env GOOGLE_CALENDAR_ID)",
      default: process.env.GOOGLE_CALENDAR_ID || "primary",
    })
    .option("date", {
      type: "string",
      describe: "Date directory (YYYY-MM-DD); defaults to latest available",
    })
    .option("from", {
      type: "string",
      describe: "Start date/time inclusive (ISO-like string)",
      default: "2026-02-01T00:00:00-06:00",
    })
    .option("to", {
      type: "string",
      describe: "End date/time inclusive (ISO-like string)",
      default: "2026-03-18T23:59:59-05:00",
    })
    .option("match", {
      type: "string",
      describe: "Case-insensitive substring to match in the event title",
      default: DEFAULT_MATCH,
    })
    .option("rate", {
      type: "number",
      describe: "Billable hourly rate in USD",
      default: DEFAULT_RATE,
    })
    .option("out", {
      type: "string",
      describe: "CSV output path",
      default: DEFAULT_CSV_OUT,
    })
    .help()
    .parse();

  const calendarId = argv["calendar-id"];
  const calendarDir = path.join(DATA_DIR, calendarId);
  if (!fs.existsSync(calendarDir)) {
    throw new Error(
      `No audit data found for calendar: ${calendarId} at ${calendarDir}`,
    );
  }

  const dateDir =
    argv.date ||
    (await pickLatestDateDir(calendarDir)) ||
    (() => {
      throw new Error(`No dated audit directories found in ${calendarDir}`);
    })();

  const from = parseEventDate(argv.from);
  const to = parseEventDate(argv.to);
  if (!from || !to) {
    throw new Error("Invalid --from or --to date.");
  }

  const csvOut = path.isAbsolute(argv.out)
    ? argv.out
    : path.join(ROOT, argv.out);

  const result = await writeCsv({
    calendarId,
    dateDir,
    csvOut,
    from,
    to,
    match: argv.match,
    rate: argv.rate,
  });

  console.log(
    `📄 Wrote ${result.matchedCount} matching events from ${result.calendarId} (${result.dateDir}).`,
  );
  console.log(`   Date range: ${formatISO(from)} to ${formatISO(to)}`);
  console.log(`   Total hours: ${result.totalHours.toFixed(2)}`);
  console.log(`   Total amount: $${result.totalAmount.toFixed(2)}`);
  console.log(`   CSV: ${result.csvOut}`);
}

main().catch((err) => {
  console.error("calendar:billable failed:", err.message);
  process.exitCode = 1;
});
