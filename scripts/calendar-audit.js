#!/usr/bin/env node
/**
 * Calendar audit script: fetches last N days of events from a chosen calendar
 * and stores them as JSON under .data/calendar-audit/<calendar-id>/<YYYY-MM-DD>/events.json.
 *
 * Notes:
 * - OAuth credentials (desktop app) must be downloaded from Google Cloud and saved to .data/credentials.json
 * - Tokens are cached at .data/token.json
 */

import path from "node:path";
import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";
import { formatISO, subDays, startOfDay, endOfDay } from "date-fns";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, ".data");
const DEFAULT_OUT_DIR = path.join(DATA_DIR, "calendar-audit");
const CREDENTIALS_PATH = path.join(DATA_DIR, "credentials.json");
const TOKEN_PATH = path.join(DATA_DIR, "token.json");
const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];

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

async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

async function saveJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, JSON.stringify(data, null, 2));
}

async function ensureCredentialsFile() {
  try {
    await fs.promises.access(CREDENTIALS_PATH, fs.constants.R_OK);
    return;
  } catch {
    // continue to attempt creation from env
  }

  const jsonString = process.env.GOOGLE_CLIENT_SECRET_JSON;
  let credentials;

  if (jsonString) {
    try {
      credentials = JSON.parse(jsonString);
    } catch (err) {
      throw new Error(
        `GOOGLE_CLIENT_SECRET_JSON is not valid JSON: ${err.message}`,
      );
    }
  } else if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    const redirectUris = process.env.GOOGLE_REDIRECT_URIS?.split(",")
      .map((u) => u.trim())
      .filter(Boolean) ?? ["http://localhost"];
    const projectId = process.env.GOOGLE_PROJECT_ID ?? "calendar-utils-local";
    credentials = {
      installed: {
        client_id: process.env.GOOGLE_CLIENT_ID,
        project_id: projectId,
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url:
          "https://www.googleapis.com/oauth2/v1/certs",
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uris: redirectUris,
      },
    };
  } else {
    throw new Error(
      `Missing credentials at ${CREDENTIALS_PATH}. Provide GOOGLE_CLIENT_SECRET_JSON or GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET in your environment.`,
    );
  }

  await saveJson(CREDENTIALS_PATH, credentials);
}

async function getAuth() {
  await ensureDir(DATA_DIR);
  await ensureCredentialsFile();

  const auth = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });

  // Persist token to TOKEN_PATH if provided by local-auth
  if (auth.credentials) {
    await saveJson(TOKEN_PATH, auth.credentials);
  }

  return auth;
}

async function resolveCalendar(calendar, calendarIdOrName) {
  // Prefer direct ID
  try {
    const res = await calendar.calendars.get({ calendarId: calendarIdOrName });
    return { id: res.data.id, summary: res.data.summary };
  } catch (err) {
    // fall through to search by name
  }

  // Search via CalendarList if not a direct ID or inaccessible
  const matches = [];
  let pageToken;
  do {
    const res = await calendar.calendarList.list({
      pageToken,
      maxResults: 250,
    });
    const items = res.data.items ?? [];
    for (const item of items) {
      if (
        item.summary?.toLowerCase().includes(calendarIdOrName.toLowerCase()) ||
        item.id?.toLowerCase().includes(calendarIdOrName.toLowerCase())
      ) {
        matches.push({ id: item.id, summary: item.summary });
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  if (matches.length === 0) {
    throw new Error(
      `No calendars matched "${calendarIdOrName}". Check the Calendar name or ID visible in your account.`,
    );
  }
  if (matches.length > 1) {
    const list = matches.map((m) => `- ${m.summary} (${m.id})`).join("\n");
    throw new Error(
      `Ambiguous calendar match for "${calendarIdOrName}". Specify an exact calendar ID.\n${list}`,
    );
  }

  return matches[0];
}

function normalizeEvent(event) {
  return {
    id: event.id ?? null,
    status: event.status ?? null,
    summary: event.summary ?? null,
    description: event.description ?? null,
    location: event.location ?? null,
    start: event.start?.dateTime ?? event.start?.date ?? null,
    end: event.end?.dateTime ?? event.end?.date ?? null,
    created: event.created ?? null,
    updated: event.updated ?? null,
    hangoutLink: event.hangoutLink ?? null,
    attendees:
      event.attendees?.map((a) => ({
        email: a.email ?? null,
        responseStatus: a.responseStatus ?? null,
        self: a.self ?? false,
      })) ?? [],
    recurringEventId: event.recurringEventId ?? null,
    iCalUID: event.iCalUID ?? null,
    raw: {
      etag: event.etag,
      kind: event.kind,
      htmlLink: event.htmlLink,
      sequence: event.sequence,
      transparency: event.transparency,
    },
  };
}

async function fetchEvents(calendar, calendarId, timeMin, timeMax) {
  const events = [];
  let pageToken;
  let pages = 0;
  do {
    const res = await calendar.events.list({
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 2500,
      pageToken,
    });
    pages += 1;
    const items = res.data.items ?? [];
    events.push(...items);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return { events, pages };
}

async function main() {
  loadEnv();

  const argv = await yargs(hideBin(process.argv))
    .option("calendar", {
      type: "string",
      describe:
        "Calendar ID or name substring to audit (env: GOOGLE_CALENDAR_ID or CALENDAR_AUDIT_CALENDAR)",
    })
    .option("days", {
      type: "number",
      describe:
        "Number of days to look back from today (env: CALENDAR_AUDIT_DAYS; default 90)",
      default: 90,
    })
    .option("out-dir", {
      type: "string",
      describe: "Output directory for audit data",
      default: DEFAULT_OUT_DIR,
    })
    .help()
    .parse();

  const calendarArg =
    argv.calendar ||
    process.env.GOOGLE_CALENDAR_ID ||
    process.env.CALENDAR_AUDIT_CALENDAR;
  if (!calendarArg) {
    throw new Error(
      "Missing calendar identifier. Provide --calendar or set GOOGLE_CALENDAR_ID / CALENDAR_AUDIT_CALENDAR.",
    );
  }

  const envDays =
    process.env.CALENDAR_AUDIT_DAYS || process.env.GOOGLE_CALENDAR_DAYS;
  const parsedEnvDays = envDays ? Number(envDays) : undefined;
  const days =
    Number.isFinite(parsedEnvDays) && parsedEnvDays > 0
      ? parsedEnvDays
      : argv.days;
  const outDir = path.isAbsolute(argv["out-dir"])
    ? argv["out-dir"]
    : path.join(ROOT, argv["out-dir"]);

  const now = new Date();
  const windowStart = startOfDay(subDays(now, days));
  const windowEnd = endOfDay(now);
  const timeMin = formatISO(windowStart);
  const timeMax = formatISO(windowEnd);

  await ensureDir(DATA_DIR);

  const auth = await getAuth();
  const calendar = google.calendar({ version: "v3", auth });

  const resolved = await resolveCalendar(calendar, calendarArg);

  const { events, pages } = await fetchEvents(
    calendar,
    resolved.id,
    timeMin,
    timeMax,
  );
  const normalized = events.map(normalizeEvent);

  const payload = {
    metadata: {
      calendarId: resolved.id,
      calendarName: resolved.summary,
      fetchedAt: formatISO(now),
      windowStart: timeMin,
      windowEnd: timeMax,
      eventCount: normalized.length,
      pagesFetched: pages,
    },
    events: normalized,
  };

  const dateSlug = formatISO(now, { representation: "date" });
  const outPath = path.join(outDir, resolved.id, dateSlug, "events.json");
  await saveJson(outPath, payload);

  console.log(
    `✅ Fetched ${normalized.length} events from "${resolved.summary}" (${resolved.id}).`,
  );
  console.log(`📄 Saved to ${outPath}`);
}

main().catch((err) => {
  console.error("calendar:audit failed:", err.message);
  process.exitCode = 1;
});
