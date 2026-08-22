/* =====================================================================
   Booking the same time every week.

   Stored the way the calendar app already stores repeats: one `lessons`
   document with repeatWeekly, and `repeat_exceptions` carving holes out
   of it. Nothing new is invented, so a weekly booking renders correctly
   in the coach's existing calendar, and the day index expands it into
   later weeks on its own as the horizon rolls forward.

   The awkward part is that a student picks one time but is really asking
   for thirteen of them, and some will already be taken. Refusing the
   whole series because week nine is busy would be useless; booking over
   the top of someone else would be worse. So each week is checked on its
   own and the ones that cannot be had are carved out as exceptions —
   which is exactly what that collection is for.
   ===================================================================== */

import type { DayWindow, Occurrence } from "./types.js";
import { addDaysWallClock, dayKey, dayTimeToUtc, formatTime } from "./time.js";
import { validateSlot, type RejectReason } from "./slotEngine.js";

export interface WeeklyOccurrence {
  date: string;
  /** ISO instant, UTC. */
  start: string;
  end: string;
  /** Belgrade wall clock, e.g. "18:00". */
  label: string;
  ok: boolean;
  reason?: RejectReason;
  message?: string;
}

export interface WeeklyPlan {
  occurrences: WeeklyOccurrence[];
  bookable: WeeklyOccurrence[];
  blocked: WeeklyOccurrence[];
}

export interface WeeklyPlanInput {
  /** The day the student actually picked. */
  firstDate: string;
  /** Belgrade wall clock of the chosen slot. */
  startLabel: string;
  lessonType: string;
  now: Date;
  /** Last day the index covers; the series is planned no further. */
  horizon: string;
  windowFor: (date: string) => DayWindow | null;
  /** What is already on that day, or null when the index has no
   *  document for it. Null is not an empty day: it means nobody has
   *  worked out what is on that date, and selling a slot against it
   *  would be guessing. */
  existingFor: (date: string) => Occurrence[] | null;
}

/** Hard ceiling, so a malformed horizon cannot spin. A year of weeks is
 *  far beyond the 90-day booking window. */
const MAX_WEEKS = 60;

/**
 * Every weekly occurrence from `firstDate` to the horizon, each marked
 * bookable or not.
 *
 * Weeks advance by Belgrade wall clock, so an 18:00 lesson stays at
 * 18:00 across the October daylight-saving change rather than drifting
 * to 17:00 — the same rule the calendar app follows.
 */
export function planWeekly(input: WeeklyPlanInput): WeeklyPlan {
  const occurrences: WeeklyOccurrence[] = [];
  const first = dayTimeToUtc(input.firstDate, input.startLabel);

  for (let week = 0; week < MAX_WEEKS; week++) {
    const start = addDaysWallClock(first, week * 7);
    const date = dayKey(start);
    if (date > input.horizon) break;

    const label = formatTime(start);
    const existing = input.existingFor(date);

    if (existing === null) {
      occurrences.push({
        date, label,
        start: start.toISOString(),
        end: start.toISOString(),
        ok: false,
        reason: "day-closed",
        message: "That week isn't ready for booking yet."
      });
      continue;
    }

    const window = input.windowFor(date);
    if (!window) {
      occurrences.push({
        date, label,
        start: start.toISOString(),
        end: start.toISOString(),
        ok: false,
        reason: "day-closed",
        message: "The coach isn't teaching that day."
      });
      continue;
    }

    // The same validator a single booking goes through, once per week,
    // so a repeat can never take a slot a one-off could not.
    const check = validateSlot({
      date,
      window,
      existing,
      lessonType: input.lessonType,
      now: input.now
    }, start.toISOString());

    occurrences.push(check.ok
      ? { date, label, start: check.slot.start, end: check.slot.end, ok: true }
      : {
          date, label,
          start: start.toISOString(),
          end: start.toISOString(),
          ok: false,
          reason: check.reason,
          message: check.message
        });
  }

  return {
    occurrences,
    bookable: occurrences.filter(o => o.ok),
    blocked: occurrences.filter(o => !o.ok)
  };
}
