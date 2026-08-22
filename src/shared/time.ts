/* =====================================================================
   Time. Every displayed time is Europe/Belgrade, hardcoded, never the
   device's timezone. Storage stays UTC ISO strings, unchanged.

   Nothing here uses the runtime's local zone. That matters more than it
   looks: the calendar app advances weekly repeats with `setDate`, which
   preserves the *browser's* wall clock across a daylight-saving change.
   Run the same arithmetic on a Netlify function (UTC) and a lesson would
   land an hour off after October, producing occStart strings that no
   longer match the exceptions written by the browser. Every helper below
   pins the zone so the two can never disagree.
   ===================================================================== */

import { TZ } from "./config.js";

export interface WallParts {
  year: number;
  month: number; // 1-12
  day: number;   // 1-31
  hour: number;  // 0-23
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday ... 6 = Saturday
}

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short"
});

const WEEKDAYS: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6
};

/** Belgrade wall-clock fields for an instant. */
export function wallParts(date: Date): WallParts {
  const map: Record<string, string> = {};
  for (const p of partsFormatter.formatToParts(date)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    // Some engines render midnight as "24" under h23; fold it back.
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: WEEKDAYS[map.weekday ?? "Sun"] ?? 0
  };
}

/** Milliseconds to add to a UTC instant to read it as Belgrade wall clock. */
export function offsetMs(date: Date): number {
  const p = wallParts(date);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Round to the second: the formatter drops milliseconds.
  return asIfUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Belgrade wall clock -> the UTC instant it names.
 *  Two passes: the first guess uses the offset in force at the guessed
 *  instant, which is wrong only within an hour of a DST boundary; the
 *  second corrects it. */
export function wallToUtc(
  year: number, month: number, day: number, hour: number, minute: number
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const firstOffset = offsetMs(new Date(guess));
  let ts = guess - firstOffset;
  const secondOffset = offsetMs(new Date(ts));
  if (secondOffset !== firstOffset) ts = guess - secondOffset;
  return new Date(ts);
}

/* ---------- Day keys ---------- */

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** "YYYY-MM-DD" for the Belgrade day an instant falls on. */
export function dayKey(date: Date): string {
  const p = wallParts(date);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

export function parseDayKey(key: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) throw new Error(`Not a day key: ${key}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** Shift a day key by whole days, without ever touching a Date's local zone. */
export function addDayKey(key: string, days: number): string {
  const { year, month, day } = parseDayKey(key);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Whole days from `from` to `to`, both day keys. Negative if `to` is earlier. */
export function daysBetweenKeys(from: string, to: string): number {
  const a = parseDayKey(from);
  const b = parseDayKey(to);
  const ms = Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day);
  return Math.round(ms / 86_400_000);
}

/** 0 = Sunday ... 6 = Saturday, for a day key. */
export function weekdayOfKey(key: string): number {
  const { year, month, day } = parseDayKey(key);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/* ---------- Wall-clock time strings ---------- */

/** "16:00" -> 960. */
export function timeToMinutes(time: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) throw new Error(`Not a wall-clock time: ${time}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 960 -> "16:00". Minutes past midnight; 24h+ wraps are the caller's problem. */
export function minutesToTime(minutes: number): string {
  const total = Math.round(minutes);
  return `${pad(Math.floor(total / 60))}:${pad(((total % 60) + 60) % 60)}`;
}

/** Day key + Belgrade wall clock ("18:15") -> the UTC instant. */
export function dayTimeToUtc(key: string, time: string): Date {
  const { year, month, day } = parseDayKey(key);
  const mins = timeToMinutes(time);
  return wallToUtc(year, month, day, Math.floor(mins / 60), mins % 60);
}

/** Minutes past midnight, Belgrade, for an instant. */
export function minutesOfDay(date: Date): number {
  const p = wallParts(date);
  return p.hour * 60 + p.minute;
}

/** "18:15" for an instant, in Belgrade, from anywhere on earth. */
export function formatTime(date: Date): string {
  const p = wallParts(date);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/* ---------- Calendar-compatible arithmetic ---------- */

/** Advance by whole days keeping the Belgrade wall clock — 18:15 stays
 *  18:15 across the October change. This is `setDate` semantics, pinned
 *  to Belgrade instead of to whatever zone the code happens to run in. */
export function addDaysWallClock(date: Date, days: number): Date {
  const p = wallParts(date);
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return wallToUtc(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    p.hour,
    p.minute
  );
}

/** Absolute minute arithmetic — durations are durations, DST or not. */
export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

/** Monday 00:00 Belgrade of the week containing `date`. */
export function weekStartMonday(date: Date): Date {
  const p = wallParts(date);
  const dow = (p.weekday + 6) % 7; // Mon = 0
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day - dow));
  return wallToUtc(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    0, 0
  );
}

/* ---------- Display ---------- */

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ, weekday: "long", day: "numeric", month: "long"
});

/** "Thursday 16 April" — Belgrade, always. */
export function formatDateLong(date: Date): string {
  return dateFormatter.format(date);
}

export function formatDayKeyLong(key: string): string {
  return formatDateLong(dayTimeToUtc(key, "12:00"));
}

/** "in 3 days", "in 4 hours", "12 minutes ago". Coarse on purpose. */
export function relativeTime(from: Date, to: Date): string {
  const mins = Math.round((to.getTime() - from.getTime()) / 60_000);
  const abs = Math.abs(mins);
  const suffix = (text: string) => (mins >= 0 ? `in ${text}` : `${text} ago`);
  if (abs < 1) return "now";
  if (abs < 60) return suffix(`${abs} minute${abs === 1 ? "" : "s"}`);
  const hours = Math.round(abs / 60);
  if (abs < 60 * 36) return suffix(`${hours} hour${hours === 1 ? "" : "s"}`);
  const days = Math.round(abs / (60 * 24));
  return suffix(`${days} day${days === 1 ? "" : "s"}`);
}

/** mm:ss, for the grace-period countdown. */
export function countdown(msRemaining: number): string {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** Whole minutes between two ISO instants. */
export function lessonMinutes(startIso: string, endIso: string): number {
  const mins = (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000;
  return Number.isFinite(mins) ? Math.max(0, Math.round(mins)) : 0;
}

export function isValidDate(d: Date): boolean {
  return d instanceof Date && !Number.isNaN(d.getTime());
}
