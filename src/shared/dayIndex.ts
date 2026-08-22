/* =====================================================================
   The day index — one flattened document per day.

     day_index/{YYYY-MM-DD}
       date       "2026-09-07"
       lessons    [ { lessonId, start, end, lessonType, clientId, ... } ]
       rebuiltAt  timestamp

   Why flatten at all: booking has to be a single-document transaction.
   Expanding repeats at booking time would need an open-ended set of
   documents inside that transaction, which Firestore cannot hold, and
   would duplicate recurrence logic the calendar app already owns. So one
   rebuild expands, applies exceptions and writes the finished list; the
   booking path reads one document, validates, writes.

   The cost is derived data, which can drift when a rebuild fails. Hence
   `rebuiltAt`: the booking page warns when the index it read is stale,
   and a scheduled rebuild heals it.
   ===================================================================== */

import type { DayIndexDoc, ExceptionDoc, LessonDoc, Occurrence } from "./types.js";
import { INDEX_EPOCH, INDEX_FORWARD_DAYS, INDEX_STALE_MINUTES } from "./config.js";
import { expandOccurrences, type ExpandOptions } from "./expand.js";
import { addDayKey, dayKey, dayTimeToUtc, daysBetweenKeys } from "./time.js";

/** Group expanded occurrences by the Belgrade day they start on. */
export function groupByDay(occurrences: Occurrence[]): Map<string, Occurrence[]> {
  const out = new Map<string, Occurrence[]>();
  for (const occ of occurrences) {
    const key = dayKey(new Date(occ.start));
    const bucket = out.get(key);
    if (bucket) bucket.push(occ);
    else out.set(key, [occ]);
  }
  for (const bucket of out.values()) bucket.sort((a, b) => a.start.localeCompare(b.start));
  return out;
}

/** Build the index documents for a run of days. Days with no lessons get
 *  an empty document rather than being skipped — an absent document and
 *  a free day must not be indistinguishable, or a failed rebuild reads
 *  as "nothing booked" and oversells the slot. */
export function buildDayIndex(
  lessons: LessonDoc[],
  exceptions: ExceptionDoc[],
  dayKeys: string[],
  options: ExpandOptions & { now?: Date } = {}
): DayIndexDoc[] {
  if (dayKeys.length === 0) return [];

  const sorted = [...dayKeys].sort();
  const rangeStart = dayTimeToUtc(sorted[0]!, "00:00");
  const rangeEnd = dayTimeToUtc(addDayKey(sorted[sorted.length - 1]!, 1), "00:00");

  const { now, ...expandOptions } = options;
  const grouped = groupByDay(
    expandOccurrences(lessons, exceptions, rangeStart, rangeEnd, expandOptions)
  );
  const rebuiltAt = (now ?? new Date()).toISOString();

  return sorted.map(date => ({
    date,
    lessons: grouped.get(date) ?? [],
    rebuiltAt
  }));
}

/** The span the index covers: a hard floor at the season epoch, because
 *  statistics read the same flattened data and must reach back to it,
 *  and 90 days forward for booking. */
export function indexRange(now: Date = new Date()): { from: string; to: string } {
  return { from: INDEX_EPOCH, to: addDayKey(dayKey(now), INDEX_FORWARD_DAYS) };
}

/** Every day key from `from` to `to`, inclusive. */
export function dayKeysBetween(from: string, to: string): string[] {
  const span = daysBetweenKeys(from, to);
  if (span < 0) return [];
  const out: string[] = [];
  for (let i = 0; i <= span; i++) out.push(addDayKey(from, i));
  return out;
}

/** True when the index document is old enough that the page should say so. */
export function isStale(rebuiltAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!rebuiltAt) return true;
  const at = new Date(rebuiltAt);
  if (Number.isNaN(at.getTime())) return true;
  return now.getTime() - at.getTime() > INDEX_STALE_MINUTES * 60_000;
}

/** Which day documents a lesson touches, so a save or delete can rebuild
 *  exactly those. A repeating lesson touches the whole forward range. */
export function affectedDayKeys(lesson: Partial<LessonDoc>, now: Date = new Date()): string[] {
  const { from, to } = indexRange(now);
  const start = lesson.start ? new Date(lesson.start) : null;

  if (lesson.repeatWeekly) {
    const first = start && !Number.isNaN(start.getTime()) ? dayKey(start) : from;
    const lastRaw = lesson.repeatEndDate ? new Date(lesson.repeatEndDate) : null;
    const last = lastRaw && !Number.isNaN(lastRaw.getTime()) ? dayKey(lastRaw) : to;
    const clampedFrom = first < from ? from : first;
    const clampedTo = last > to ? to : last;
    return dayKeysBetween(clampedFrom, clampedTo);
  }

  if (!start || Number.isNaN(start.getTime())) return [];
  const key = dayKey(start);
  return key >= from && key <= to ? [key] : [];
}
