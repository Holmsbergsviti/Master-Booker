/* =====================================================================
   Statistics. No pay calculation — counts, hours and patterns only.

   A season runs 1 September to 31 August, and nothing before 1 September
   2026 is counted. The dashboards default to the current season with a
   selector for later ones, so next year gives a year-on-year comparison
   rather than a lifetime total that hides whether anything is improving.

   Everything here reads the day index, the same flattened data booking
   reads. There is no second code path, so a lesson can never count in
   one place and not the other.
   ===================================================================== */

import type { AvailabilityDoc, BookingLogDoc, DayIndexDoc, Occurrence } from "./types.js";
import { INDEX_EPOCH, lessonSpec } from "./config.js";
import { offeredMinutes } from "./availability.js";
import { addDayKey, dayKey, daysBetweenKeys } from "./time.js";
import { dayKeysBetween } from "./dayIndex.js";

export interface Season {
  /** The year the season starts in: 2026 means 2026-09-01 to 2027-08-31. */
  startYear: number;
  from: string;
  to: string;
  label: string;
}

export function seasonForYear(startYear: number): Season {
  const from = `${startYear}-09-01`;
  const to = `${startYear + 1}-08-31`;
  return {
    startYear,
    // Nothing before the epoch is counted, whatever the season nominally
    // spans. The first season is short by design.
    from: from < INDEX_EPOCH ? INDEX_EPOCH : from,
    to,
    label: `${startYear}/${String(startYear + 1).slice(2)}`
  };
}

/** The season a date falls in. September starts a new one. */
export function seasonOf(date: string): Season {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return seasonForYear(month >= 9 ? year : year - 1);
}

/** Every season from the epoch to now, newest first. */
export function seasonsAvailable(now: Date = new Date()): Season[] {
  const first = seasonOf(INDEX_EPOCH).startYear;
  const current = seasonOf(dayKey(now)).startYear;
  const out: Season[] = [];
  for (let y = current; y >= first; y--) out.push(seasonForYear(y));
  return out;
}

/* ---------- shaping ---------- */

export interface LessonTally {
  count: number;
  minutes: number;
  byType: Record<string, number>;
}

function emptyTally(): LessonTally {
  return { count: 0, minutes: 0, byType: {} };
}

function add(tally: LessonTally, occ: Occurrence): void {
  const mins = Math.max(0, Math.round(
    (new Date(occ.end).getTime() - new Date(occ.start).getTime()) / 60_000
  ));
  tally.count++;
  tally.minutes += mins;
  const type = occ.lessonType || "class";
  tally.byType[type] = (tally.byType[type] ?? 0) + 1;
}

export interface PeriodTally extends LessonTally {
  /** "2026-09" for a month, "2026-W37" for a week. */
  key: string;
}

/** ISO-ish week key. Weeks start Monday, matching the calendar app. */
function weekKey(date: string): string {
  // Days since a known Monday, floored into week buckets.
  const anchor = "2026-08-31"; // a Monday
  const offset = daysBetweenKeys(anchor, date);
  const week = Math.floor(offset / 7);
  return addDayKey(anchor, week * 7);
}

export interface CoachStats {
  season: Season;
  total: LessonTally;
  byMonth: PeriodTally[];
  byWeek: PeriodTally[];
  byClient: Array<{ clientId: string | null; label: string } & LessonTally>;
  cancellations: { total: number; byClient: Record<string, number> };
  /** Hours booked against hours offered, plus the idle time absorbed. */
  utilisation: {
    offeredMinutes: number;
    bookedMinutes: number;
    ratio: number;
    idleMinutes: number;
  };
}

export interface CoachStatsInput {
  season: Season;
  days: DayIndexDoc[];
  cancellations: BookingLogDoc[];
  availability: AvailabilityDoc[];
  clientNames: Map<string, string>;
  /** Days after this are scheduled, not taught; utilisation only counts
   *  what has actually happened. */
  through?: string;
}

export function coachStats(input: CoachStatsInput): CoachStats {
  const { season, clientNames } = input;
  const through = input.through ?? season.to;

  const total = emptyTally();
  const months = new Map<string, PeriodTally>();
  const weeks = new Map<string, PeriodTally>();
  const clients = new Map<string, LessonTally>();
  const idleByDay: number[] = [];

  for (const day of input.days) {
    if (day.date < season.from || day.date > season.to) continue;
    const lessons = day.lessons ?? [];

    for (const occ of lessons) {
      add(total, occ);

      const monthKey = day.date.slice(0, 7);
      const month = months.get(monthKey) ?? { key: monthKey, ...emptyTally() };
      add(month, occ);
      months.set(monthKey, month);

      const wk = weekKey(day.date);
      const week = weeks.get(wk) ?? { key: wk, ...emptyTally() };
      add(week, occ);
      weeks.set(wk, week);

      const clientKey = occ.clientId ?? `title:${occ.title ?? "Unknown"}`;
      const client = clients.get(clientKey) ?? emptyTally();
      add(client, occ);
      clients.set(clientKey, client);
    }

    if (day.date <= through) idleByDay.push(idleMinutesForDay(lessons));
  }

  const bookedMinutes = input.days
    .filter(d => d.date >= season.from && d.date <= through)
    .reduce((sum, d) => sum + (d.lessons ?? []).reduce((s, occ) =>
      s + Math.round((new Date(occ.end).getTime() - new Date(occ.start).getTime()) / 60_000), 0), 0);

  // Deliberately derived from the calendar, not from the index documents
  // that happen to be present. Counting only the days with a document
  // would let a failed rebuild drop a day out of the denominator, and
  // utilisation would quietly improve at exactly the moment something
  // was broken.
  const offered = offeredMinutes(
    input.availability,
    dayKeysBetween(season.from, through < season.to ? through : season.to)
  );

  const cancellationsByClient: Record<string, number> = {};
  let cancellationTotal = 0;
  for (const log of input.cancellations) {
    const date = dayKey(new Date(log.start));
    if (date < season.from || date > season.to) continue;
    cancellationTotal++;
    cancellationsByClient[log.clientId] = (cancellationsByClient[log.clientId] ?? 0) + 1;
  }

  return {
    season,
    total,
    byMonth: [...months.values()].sort((a, b) => a.key.localeCompare(b.key)),
    byWeek: [...weeks.values()].sort((a, b) => a.key.localeCompare(b.key)),
    byClient: [...clients.entries()]
      .map(([key, tally]) => ({
        clientId: key.startsWith("title:") ? null : key,
        label: key.startsWith("title:") ? key.slice(6) : (clientNames.get(key) ?? "Unknown client"),
        ...tally
      }))
      .sort((a, b) => b.minutes - a.minutes),
    cancellations: { total: cancellationTotal, byClient: cancellationsByClient },
    utilisation: {
      offeredMinutes: offered,
      bookedMinutes,
      // Utilisation is the metric that closes the loop on the original
      // problem: high utilisation with near-zero idle time means the gap
      // budget can be loosened, and idle hours accumulating means
      // tighten it.
      ratio: offered > 0 ? bookedMinutes / offered : 0,
      idleMinutes: idleByDay.reduce((a, b) => a + b, 0)
    }
  };
}

/** Idle minutes inside the taught part of one day: last end minus first
 *  start, minus the lessons themselves. Deliberately simpler than the
 *  booking metric — no break credit — because this is the raw number the
 *  coach wants to see, not a budget comparison. */
function idleMinutesForDay(lessons: Occurrence[]): number {
  if (lessons.length < 2) return 0;
  const times = lessons.map(l => ({
    start: new Date(l.start).getTime(),
    end: new Date(l.end).getTime()
  })).sort((a, b) => a.start - b.start);
  const span = times[times.length - 1]!.end - times[0]!.start;
  const busy = times.reduce((sum, t) => sum + (t.end - t.start), 0);
  return Math.max(0, Math.round((span - busy) / 60_000));
}

/* ---------- client dashboard ---------- */

export interface ClientStats {
  season: Season;
  total: LessonTally;
  byMonth: PeriodTally[];
  upcoming: Occurrence[];
  cancellations: number;
}

export function clientStats(
  clientId: string,
  days: DayIndexDoc[],
  cancellations: BookingLogDoc[],
  season: Season,
  now: Date = new Date()
): ClientStats {
  const total = emptyTally();
  const months = new Map<string, PeriodTally>();
  const upcoming: Occurrence[] = [];
  const nowIso = now.toISOString();

  for (const day of days) {
    if (day.date < season.from || day.date > season.to) continue;
    for (const occ of day.lessons ?? []) {
      if (occ.clientId !== clientId) continue;
      if (occ.start > nowIso) {
        upcoming.push(occ);
        continue;
      }
      add(total, occ);
      const key = day.date.slice(0, 7);
      const month = months.get(key) ?? { key, ...emptyTally() };
      add(month, occ);
      months.set(key, month);
    }
  }

  return {
    season,
    total,
    byMonth: [...months.values()].sort((a, b) => a.key.localeCompare(b.key)),
    upcoming: upcoming.sort((a, b) => a.start.localeCompare(b.start)),
    cancellations: cancellations.filter(c =>
      c.clientId === clientId &&
      dayKey(new Date(c.start)) >= season.from &&
      dayKey(new Date(c.start)) <= season.to
    ).length
  };
}

/** Minutes as "4h 30m", for display. */
export function formatHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Total minutes a lesson type occupies, for tallies built from types
 *  rather than from timestamps. */
export function minutesForType(type: string): number {
  return lessonSpec(type).mins;
}
