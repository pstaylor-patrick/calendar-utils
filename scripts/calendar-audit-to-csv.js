#!/usr/bin/env node
/**
 * Convert the latest calendar audit JSON into a grouped hours CSV.
 *
 * Default input: latest date folder under
 *   .data/calendar-audit/<calendar-id>/YYYY-MM-DD/events.json
 * Default output: ./calendar-hours.csv (gitignored).
 */

import path from "node:path";
import fs from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  differenceInMilliseconds,
  formatISO,
  parseISO,
  startOfWeek,
} from "date-fns";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, ".data", "calendar-audit");
const DEFAULT_CSV_OUT = path.join(ROOT, "calendar-hours.csv");
const DEFAULT_JSON_OUT = path.join(ROOT, "calendar-hours.json");
const CLIENTS_PATH = path.join(ROOT, "clients.json");

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

async function loadClients() {
  if (!fs.existsSync(CLIENTS_PATH)) {
    throw new Error(
      `Missing clients.json. Copy clients.example.json to clients.json and personalize client names/aliases.`,
    );
  }
  const raw = await readFile(CLIENTS_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  const ordered = Object.keys(parsed);
  const matchers = ordered.map((name) => {
    const keywords = [name, ...(parsed[name] ?? [])]
      .map((s) => (s || "").toLowerCase())
      .filter(Boolean);
    return { name, keywords };
  });
  return { ordered, aliases: matchers };
}

function classifyClient(summary, aliases) {
  const lower = (summary ?? "").toLowerCase();
  for (const matcher of aliases) {
    if (matcher.keywords.some((kw) => lower.includes(kw))) {
      return matcher.name;
    }
  }
  return "Other";
}

async function pickLatestDateDir(calendarDir) {
  const entries = await readdir(calendarDir, { withFileTypes: true });
  const dateDirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .sort()
    .reverse();
  return dateDirs[0];
}

function parseEventDate(value) {
  if (!value) return null;
  const str =
    typeof value === "string" ? value : value.dateTime || value.date || null;
  if (!str) return null;
  try {
    return parseISO(str);
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

async function loadEvents(filePath) {
  const raw = await readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  return parsed.events ?? [];
}

function bucketEventsByWeek(events, clients) {
  const totals = new Map(); // week -> client -> data
  for (const event of events) {
    const hours = eventDurationHours(event);
    if (hours <= 0) continue;
    const start = parseEventDate(event.start);
    if (!start) continue;
    const weekStart = startOfWeek(start, { weekStartsOn: 1 });
    const weekKey = formatISO(weekStart, { representation: "date" });
    const summary = event.summary ?? "(untitled)";
    const client = classifyClient(summary, clients.aliases);

    if (!totals.has(weekKey)) totals.set(weekKey, new Map());
    const weekMap = totals.get(weekKey);
    const clientData = weekMap.get(client) ?? {
      client,
      weekStart: weekKey,
      hours: 0,
      count: 0,
      summaries: new Map(),
    };
    clientData.hours += hours;
    clientData.count += 1;

    const summaryData = clientData.summaries.get(summary) ?? {
      summary,
      hours: 0,
      count: 0,
    };
    summaryData.hours += hours;
    summaryData.count += 1;
    clientData.summaries.set(summary, summaryData);

    weekMap.set(client, clientData);
  }

  // Convert to arrays preserving client order from config, then "Other"
  const weekEntries = Array.from(totals.entries())
    .map(([weekStart, clientMap]) => {
      const orderedClients = [];
      for (const name of clients.ordered) {
        if (clientMap.has(name)) orderedClients.push(clientMap.get(name));
      }
      if (clientMap.has("Other")) orderedClients.push(clientMap.get("Other"));
      return {
        weekStart,
        clients: orderedClients.map((c) => ({
          ...c,
          summaries: Array.from(c.summaries.values()).sort((a, b) =>
            a.summary.localeCompare(b.summary),
          ),
        })),
      };
    })
    .sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1)); // newest first

  return weekEntries;
}

async function writeReports({ calendarId, dateDir, csvOut, jsonOut }) {
  const eventsPath = path.join(DATA_DIR, calendarId, dateDir, "events.json");
  const events = await loadEvents(eventsPath);
  const clients = await loadClients();
  const weeks = bucketEventsByWeek(events, clients);

  const rows = [["week_start", "client", "hours", "count"]];
  for (const week of weeks) {
    for (const client of week.clients) {
      rows.push([
        week.weekStart,
        csvEscape(client.client),
        client.hours.toFixed(2),
        String(client.count),
      ]);
    }
  }

  const csv = rows.map((r) => r.join(",")).join("\n");
  await writeFile(csvOut, csv);
  await writeFile(jsonOut, JSON.stringify({ weeks }, null, 2));

  return { rows: rows.length - 1, csvOut, jsonOut, dateDir, calendarId };
}

async function main() {
  loadEnv();

  const argv = await yargs(hideBin(process.argv))
    .option("calendar-id", {
      type: "string",
      describe:
        "Calendar ID to read from .data/calendar-audit (env: GOOGLE_CALENDAR_ID or CALENDAR_AUDIT_CALENDAR)",
    })
    .option("date", {
      type: "string",
      describe: "Date directory (YYYY-MM-DD); defaults to latest available",
    })
    .option("out", {
      type: "string",
      describe: "CSV output path",
      default: DEFAULT_CSV_OUT,
    })
    .option("json-out", {
      type: "string",
      describe: "JSON output path",
      default: DEFAULT_JSON_OUT,
    })
    .help()
    .parse();

  const calendarId =
    argv["calendar-id"] ||
    process.env.GOOGLE_CALENDAR_ID ||
    process.env.CALENDAR_AUDIT_CALENDAR;
  if (!calendarId) {
    throw new Error(
      "Missing calendar ID. Provide --calendar-id or set GOOGLE_CALENDAR_ID / CALENDAR_AUDIT_CALENDAR.",
    );
  }

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

  const csvOut = path.isAbsolute(argv.out)
    ? argv.out
    : path.join(ROOT, argv.out);
  const jsonOut = path.isAbsolute(argv["json-out"])
    ? argv["json-out"]
    : path.join(ROOT, argv["json-out"]);

  const { rows } = await writeReports({
    calendarId,
    dateDir,
    csvOut,
    jsonOut,
  });
  console.log(`📄 Wrote ${rows} weekly groups from ${dateDir}`);
  console.log(`   CSV:  ${csvOut}`);
  console.log(`   JSON: ${jsonOut}`);
}

main().catch((err) => {
  console.error("calendar:csv failed:", err.message);
  process.exitCode = 1;
});
