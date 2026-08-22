/* =====================================================================
   Resolving availability for a day.

   Windows are stored as wall-clock strings ("16:00"), never as UTC
   offsets, or the schedule drifts an hour at every daylight-saving
   change. A dated entry beats a recurring one, so the coach can carve a
   single evening out without touching the weekly pattern.
   ===================================================================== */

import type { AvailabilityDoc, DayWindow } from "./types.js";
import { COACH } from "./config.js";
import { timeToMinutes, weekdayOfKey } from "./time.js";

/** The window in force on `date`, or null when the coach is not teaching. */
export function windowForDay(
  docs: AvailabilityDoc[],
  date: string,
  coach: string = COACH
): DayWindow | null {
  const mine = docs.filter(d => !d.coach || d.coach === coach);

  // An explicit date is an override, including an override to "closed".
  const dated = mine.filter(d => d.date === date);
  if (dated.length > 0) {
    const chosen = dated[dated.length - 1]!;
    return chosen.closed ? null : toWindow(chosen, date);
  }

  const weekday = weekdayOfKey(date);
  const recurring = mine
    .filter(d => !d.date && d.weekday === weekday)
    .filter(d => !d.validFrom || d.validFrom <= date)
    .filter(d => !d.validUntil || d.validUntil >= date)
    // Latest validFrom wins, so a new pattern supersedes an old one
    // without anyone having to delete the old row.
    .sort((a, b) => (a.validFrom ?? "").localeCompare(b.validFrom ?? ""));

  const chosen = recurring[recurring.length - 1];
  if (!chosen || chosen.closed) return null;
  return toWindow(chosen, date);
}

function toWindow(doc: AvailabilityDoc, date: string): DayWindow | null {
  try {
    if (timeToMinutes(doc.end) <= timeToMinutes(doc.start)) return null;
  } catch {
    return null;
  }
  return {
    date,
    start: doc.start,
    end: doc.end,
    gapBudget: doc.gapBudget ?? null
  };
}

/** Hours the coach offered across a run of days — the denominator of
 *  window utilisation. */
export function offeredMinutes(docs: AvailabilityDoc[], dates: string[], coach: string = COACH): number {
  let total = 0;
  for (const date of dates) {
    const w = windowForDay(docs, date, coach);
    if (w) total += timeToMinutes(w.end) - timeToMinutes(w.start);
  }
  return total;
}
