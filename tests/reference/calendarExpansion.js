/* =====================================================================
   A faithful copy of the occurrence expansion in the calendar app
   (petarCalendar/app.js — `occurrencesInRange` and the date helpers it
   uses), reproduced here so the day index can be diffed against it.

   Deliberately unmodified, including the browser-local `setDate`
   arithmetic and the 64-iteration cap. Run it with TZ=Europe/Belgrade
   and it behaves exactly as the coach's browser does; that is the
   comparison Phase 1 has to pass.
   ===================================================================== */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function isValidDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

function weekStartMonday(date) {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // Mon=0 ... Sun=6
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function addMinutes(date, mins) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() + mins);
  return d;
}

/** How app.js turns raw Firestore documents into `lessonCache`. */
export function buildLessonCache(docs) {
  const cache = [];
  for (const d of docs) {
    const baseStart = new Date(d.start);
    const baseEnd = new Date(d.end);
    if (!isValidDate(baseStart) || !isValidDate(baseEnd)) continue;
    cache.push({
      id: d.id,
      title: d.title || "Untitled lesson",
      coach: Array.isArray(d.coach) ? d.coach : d.coach ? [d.coach] : [],
      lessonType: d.lessonType || "class",
      repeatWeekly: !!d.repeatWeekly,
      repeatEndDate: d.repeatEndDate || null,
      start: d.start,
      durationMins: Math.max(1, Math.round((baseEnd - baseStart) / 60000))
    });
  }
  return cache;
}

/** How app.js turns `repeat_exceptions` into `cancelledSet`. */
export function buildCancelledSet(exceptions) {
  const cancelled = new Set();
  for (const x of exceptions) {
    if (x.type === "cancel") cancelled.add(`${x.parentId}__${x.occStart}`);
  }
  return cancelled;
}

export function occurrencesInRange(lessonCache, cancelledSet, rangeStart, rangeEnd) {
  const out = [];

  for (const l of lessonCache) {
    const baseStart = new Date(l.start);
    if (!isValidDate(baseStart)) continue;

    const push = occStart => {
      const occEnd = addMinutes(occStart, l.durationMins);
      if (occEnd <= rangeStart || occStart >= rangeEnd) return;
      if (cancelledSet.has(`${l.id}__${occStart.toISOString()}`)) return;
      out.push({ lesson: l, start: occStart, end: occEnd });
    };

    if (!l.repeatWeekly) {
      push(baseStart);
      continue;
    }

    const endLimit = l.repeatEndDate ? new Date(l.repeatEndDate) : null;
    const offset = Math.max(
      0,
      Math.round((weekStartMonday(rangeStart) - weekStartMonday(baseStart)) / WEEK_MS)
    );

    for (let i = 0; i < 64; i++) {
      const occStart = addDays(baseStart, (offset + i) * 7);
      if (endLimit && occStart > endLimit) break;
      if (occStart >= rangeEnd) break;
      push(occStart);
    }
  }

  return out;
}

/** The comparable shape: which lesson, at which instant. */
export function fingerprint(occurrences) {
  return occurrences
    .map(o => `${o.lesson.id}@${o.start.toISOString()}`)
    .sort();
}
