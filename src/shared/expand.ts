/* =====================================================================
   Occurrence expansion.

   Repeating lessons are stored as a rule, not as rows: one `lessons`
   document with repeatWeekly represents every future week, and
   `repeat_exceptions` carves holes out of it. Nothing in the database
   directly says "18:15 next Thursday is taken" — that fact only exists
   once the rule is expanded, which is what this file does.

   This is a deliberate re-implementation of `occurrencesInRange` in the
   calendar app's app.js. It must agree with it on every day, because the
   two render the same lessons to the same coach. Differences that were
   *not* copied, and why:

     - Weeks advance by Belgrade wall clock rather than the runtime's
       local zone, so a Netlify function (UTC) gets the same instants the
       coach's browser does. See time.ts.
     - The 64-iteration cap is lifted. It is sized for a six-week month
       view; the day index spans a season.

   `parentId` plays no part here. When a series is split, the child is an
   ordinary standalone document and expands like any other; the hole in
   the parent comes from `repeatEndDate` or from an exception.
   ===================================================================== */

import type { ExceptionDoc, LessonDoc, Occurrence } from "./types.js";
import { COACH, DEFAULT_LESSON_TYPE } from "./config.js";
import {
  addDaysWallClock, addMinutes, isValidDate, weekStartMonday
} from "./time.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Guard against a malformed document producing an unbounded loop. Far
 *  above the ~65 weeks a season-long index needs. */
const MAX_OCCURRENCES_PER_SERIES = 600;

/** The key an exception uses to name one occurrence of one series. */
export function occurrenceKey(lessonId: string, occStartIso: string): string {
  return `${lessonId}__${occStartIso}`;
}

/** Only `cancel` is written by the calendar app today. Any other type is
 *  ignored rather than guessed at, so an exception kind added later
 *  cannot silently start deleting lessons from the index. */
export function cancelledKeys(exceptions: ExceptionDoc[]): Set<string> {
  const out = new Set<string>();
  for (const ex of exceptions) {
    if (ex?.type === "cancel" && ex.parentId && ex.occStart) {
      out.add(occurrenceKey(ex.parentId, ex.occStart));
    }
  }
  return out;
}

export interface ExpandOptions {
  /** Keep only lessons this coach is on. Pass null to keep all. */
  coach?: string | null;
}

/** Every occurrence overlapping [rangeStart, rangeEnd). */
export function expandOccurrences(
  lessons: LessonDoc[],
  exceptions: ExceptionDoc[],
  rangeStart: Date,
  rangeEnd: Date,
  options: ExpandOptions = {}
): Occurrence[] {
  const coach = options.coach === undefined ? COACH : options.coach;
  const cancelled = cancelledKeys(exceptions);
  const out: Occurrence[] = [];

  for (const lesson of lessons) {
    const coaches = normaliseCoaches(lesson.coach);
    if (coach && !coaches.includes(coach)) continue;

    const baseStart = new Date(lesson.start);
    const baseEnd = new Date(lesson.end);
    if (!isValidDate(baseStart) || !isValidDate(baseEnd)) continue;

    const durationMins = Math.max(1, Math.round((baseEnd.getTime() - baseStart.getTime()) / 60_000));

    const push = (occStart: Date) => {
      const occEnd = addMinutes(occStart, durationMins);
      if (occEnd <= rangeStart || occStart >= rangeEnd) return;
      const occIso = occStart.toISOString();
      if (cancelled.has(occurrenceKey(lesson.id, occIso))) return;
      out.push({
        lessonId: lesson.id,
        start: occIso,
        end: occEnd.toISOString(),
        occStart: occIso,
        lessonType: lesson.lessonType || DEFAULT_LESSON_TYPE,
        coach: coaches,
        title: lesson.title ?? null,
        clientId: lesson.clientId ?? null,
        source: lesson.source ?? null,
        flexible: !!lesson.flexible,
        graceUntil: lesson.graceUntil ?? null,
        repeatWeekly: !!lesson.repeatWeekly
      });
    };

    if (!lesson.repeatWeekly) {
      push(baseStart);
      continue;
    }

    const endLimitRaw = lesson.repeatEndDate ? new Date(lesson.repeatEndDate) : null;
    const endLimit = endLimitRaw && isValidDate(endLimitRaw) ? endLimitRaw : null;

    // Jump straight to the week the range starts in rather than walking
    // from the series start, which may be a year back.
    const offset = Math.max(
      0,
      Math.round(
        (weekStartMonday(rangeStart).getTime() - weekStartMonday(baseStart).getTime()) / WEEK_MS
      )
    );

    for (let i = 0; i < MAX_OCCURRENCES_PER_SERIES; i++) {
      const occStart = addDaysWallClock(baseStart, (offset + i) * 7);
      if (endLimit && occStart > endLimit) break;
      if (occStart >= rangeEnd) break;
      push(occStart);
    }
  }

  out.sort((a, b) => a.start.localeCompare(b.start) || a.lessonId.localeCompare(b.lessonId));
  return out;
}

/** The calendar app tolerates `coach` being a bare string on old rows. */
function normaliseCoaches(coach: unknown): string[] {
  if (Array.isArray(coach)) return coach.filter((c): c is string => typeof c === "string");
  if (typeof coach === "string" && coach) return [coach];
  return [];
}
