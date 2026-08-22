/* =====================================================================
   The rules engine.

   The problem it exists to solve: availability is 16:00-21:00, a student
   books 18:00, and a naive "only offer adjacent slots" rule then refuses
   19:30 — even though in real life the coach would happily take it and
   slot someone into 18:45 later.

   So don't check adjacency. Check how much idle time a booking leaves
   behind:

       span = last lesson end - first lesson start
       dead = span - SUM(durations) - (15 x breaks earned)

   and permit a booking when

       after.dead <= max(before.dead, budget)

   Never make the day worse than it already is. The max() matters: a hole
   left by someone else's cancellation must not block a student who wants
   to extend the end of the evening over a gap they did not create.

   Everything below works in minutes past midnight, Belgrade. A daylight
   saving transition happens at 02:00 and so can never fall inside an
   evening window; durations stay durations and the arithmetic stays
   integer.
   ===================================================================== */

import type { DayWindow, Occurrence, Slot } from "./types.js";
import {
  BOOK_CUTOFF_HOURS, BREAK_MINUTES, BREAK_RESET_MINUTES, BUDGET_RELAXATION,
  CANCEL_CUTOFF_HOURS, GAP_BUDGET_TABLE, LESSONS_PER_BREAK, MIN_SLOTS_OFFERED,
  SLOT_ALIGN_MINUTES, lessonSpec
} from "./config.js";
import { dayKey, dayTimeToUtc, minutesOfDay, minutesToTime, timeToMinutes } from "./time.js";

/** A lesson reduced to what the metric needs. */
export interface Interval {
  startMin: number;
  endMin: number;
  /** How much it counts toward the three-lessons-then-break rule. */
  weight: number;
}

/* =====================================================================
   Dead time
   ===================================================================== */

export interface DeadTime {
  /** Idle minutes that are not earned rest. */
  dead: number;
  /** Last end minus first start; 0 for an empty day. */
  span: number;
  /** Idle minutes credited as rest. */
  restCredited: number;
}

/**
 * A break is only *earned* when it was required. Fifteen idle minutes
 * after the first lesson of the day is dead time; fifteen idle minutes
 * after the third is rest and costs nothing against the budget.
 *
 * Lessons count by weight, so a 90-minute Double counts double and earns
 * its break after two. Weight is configuration, not logic — set
 * `private60` to 1.5 and three premium lessons break after two instead.
 */
export function deadTime(lessons: Interval[]): DeadTime {
  if (lessons.length === 0) return { dead: 0, span: 0, restCredited: 0 };

  const sorted = [...lessons].sort((a, b) => a.startMin - b.startMin);
  const first = sorted[0]!;
  let lastEnd = first.endMin;
  for (const l of sorted) lastEnd = Math.max(lastEnd, l.endMin);

  const span = lastEnd - first.startMin;
  let busy = 0;
  for (const l of sorted) busy += l.endMin - l.startMin;

  let consecutive = 0;
  let breakDue = false;
  let restCredited = 0;

  for (let i = 0; i < sorted.length; i++) {
    consecutive += sorted[i]!.weight;
    if (consecutive >= LESSONS_PER_BREAK) {
      breakDue = true;
      consecutive -= LESSONS_PER_BREAK;
    }

    const next = sorted[i + 1];
    if (!next) break;

    // Overlapping lessons (the coach can create them) would otherwise
    // produce a negative gap and credit rest that never happened.
    const gap = Math.max(0, next.startMin - sorted[i]!.endMin);
    if (gap === 0) continue;

    if (breakDue) {
      // Never credit more rest than idle time actually taken, so `dead`
      // cannot go negative on a day that ends right after a third lesson.
      restCredited += Math.min(BREAK_MINUTES, gap);
      breakDue = false;
    }

    // Any real break resets the consecutive counter — the coach has had
    // their rest and starts fresh.
    if (gap >= BREAK_RESET_MINUTES) {
      consecutive = 0;
      breakDue = false;
    }
  }

  // Overlaps can push busy past span; clamp rather than report a
  // negative, which would read as "better than perfect".
  const dead = Math.max(0, span - busy - restCredited);
  return { dead, span, restCredited };
}

/* =====================================================================
   Gap budget
   ===================================================================== */

/**
 * Idle time permitted, by lead time to the START of that day's
 * availability window — not to the individual slot, so a whole day
 * tightens at once rather than early slots locking before late ones.
 *
 * Boundaries resolve to the looser budget: the table's "3-7 days" band
 * is read as [3 days, 7 days). The difference only ever bites within one
 * minute of a boundary.
 */
export function gapBudget(
  windowStart: Date,
  now: Date,
  override: number | null | undefined = null
): number {
  if (override !== null && override !== undefined) return override;
  const leadHours = (windowStart.getTime() - now.getTime()) / 3_600_000;
  for (const row of GAP_BUDGET_TABLE) {
    if (leadHours >= row.minLeadHours) return row.budgetMinutes;
  }
  return 0;
}

/* =====================================================================
   Slot generation
   ===================================================================== */

export interface SlotRequest {
  /** Day key, "2026-09-07". */
  date: string;
  window: DayWindow;
  /** Whatever the day index says is already on the calendar. */
  existing: Occurrence[];
  /** The type the client books, which fixes the duration. */
  lessonType: string;
  now: Date;
}

export type RejectReason =
  | "outside-window"
  | "overlap"
  | "past-book-cutoff"
  | "not-aligned"
  | "too-much-dead-time"
  | "day-closed";

export interface Candidate {
  startMin: number;
  endMin: number;
  ok: boolean;
  reason?: RejectReason;
  deadAfter: number;
  deadBefore: number;
  budget: number;
}

/** Turn indexed occurrences into the intervals the metric works on.
 *  Occurrences that do not fall on this day are dropped rather than
 *  wrapped, so a stray document cannot distort the whole evening. */
export function toIntervals(existing: Occurrence[], date: string): Interval[] {
  const out: Interval[] = [];
  for (const occ of existing) {
    const start = new Date(occ.start);
    const end = new Date(occ.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (dayKey(start) !== date) continue;
    const startMin = minutesOfDay(start);
    let endMin = minutesOfDay(end);
    // A lesson ending exactly at midnight reads as 0; treat it as 24:00.
    if (endMin <= startMin) endMin = startMin + Math.round((end.getTime() - start.getTime()) / 60_000);
    out.push({ startMin, endMin, weight: lessonSpec(occ.lessonType).breakWeight });
  }
  return out.sort((a, b) => a.startMin - b.startMin);
}

/**
 * Every 15-minute-aligned start time in the window, tested against the
 * rules. Around twenty candidates per day — trivial to compute, and it
 * means there is exactly one definition of "legal", used for both
 * display and confirmation.
 *
 * The budget is loosened here rather than by the caller, so the list a
 * student sees and the list /api/book accepts are produced by the same
 * pass. Relaxing in only one of them would let someone book a slot the
 * page never offered, or be refused one it did.
 */
export function evaluateCandidates(req: SlotRequest): Candidate[] {
  const windowStartUtc = dayTimeToUtc(req.date, req.window.start);
  const base = gapBudget(windowStartUtc, req.now, req.window.gapBudget);

  let result = candidatesAtBudget(req, base);
  if (countOk(result) >= MIN_SLOTS_OFFERED) return result;

  // A per-day override is the coach saying exactly what they want; do
  // not talk them out of it.
  if (req.window.gapBudget !== null && req.window.gapBudget !== undefined) return result;

  for (const budget of BUDGET_RELAXATION) {
    if (budget <= base) continue;
    const looser = candidatesAtBudget(req, budget);
    if (countOk(looser) > countOk(result)) result = looser;
    if (countOk(result) >= MIN_SLOTS_OFFERED) break;
  }
  return result;
}

function countOk(candidates: Candidate[]): number {
  return candidates.reduce((n, c) => n + (c.ok ? 1 : 0), 0);
}

function candidatesAtBudget(req: SlotRequest, budget: number): Candidate[] {
  const spec = lessonSpec(req.lessonType);
  const duration = spec.mins;
  const windowStartMin = timeToMinutes(req.window.start);
  const windowEndMin = timeToMinutes(req.window.end);

  const existing = toIntervals(req.existing, req.date);
  const before = deadTime(existing);

  const cutoffMs = BOOK_CUTOFF_HOURS * 3_600_000;
  const out: Candidate[] = [];

  for (let startMin = windowStartMin; startMin + duration <= windowEndMin; startMin += SLOT_ALIGN_MINUTES) {
    const endMin = startMin + duration;
    const candidate: Candidate = {
      startMin, endMin, ok: false, deadAfter: 0, deadBefore: before.dead, budget
    };

    if (overlapsAny(existing, startMin, endMin)) {
      candidate.reason = "overlap";
      out.push(candidate);
      continue;
    }

    // To the minute. "Tomorrow" never means "any time tomorrow".
    const startUtc = dayTimeToUtc(req.date, minutesToTime(startMin));
    if (startUtc.getTime() - req.now.getTime() < cutoffMs) {
      candidate.reason = "past-book-cutoff";
      out.push(candidate);
      continue;
    }

    const after = deadTime([...existing, { startMin, endMin, weight: spec.breakWeight }]);
    candidate.deadAfter = after.dead;

    if (after.dead > Math.max(before.dead, budget)) {
      candidate.reason = "too-much-dead-time";
      out.push(candidate);
      continue;
    }

    candidate.ok = true;
    out.push(candidate);
  }

  return out;
}

/** The candidates a client is actually offered. Slots that *close* an
 *  existing gap are flagged so the UI can surface them first. */
export function offeredSlots(req: SlotRequest): Slot[] {
  return evaluateCandidates(req)
    .filter(c => c.ok)
    .map(c => {
      const label = minutesToTime(c.startMin);
      return {
        start: dayTimeToUtc(req.date, label).toISOString(),
        end: dayTimeToUtc(req.date, minutesToTime(c.endMin)).toISOString(),
        label,
        deadAfter: c.deadAfter,
        closesGap: c.deadAfter < c.deadBefore
      };
    });
}

export type ValidationResult =
  | { ok: true; slot: Slot }
  | { ok: false; reason: RejectReason; message: string };

/**
 * Confirmation runs the same generator display did, then looks the
 * requested time up in the result. Not a parallel implementation of the
 * same rules — literally the same call — so a slot shown as bookable and
 * a slot accepted at write time cannot disagree.
 */
export function validateSlot(req: SlotRequest, startIso: string): ValidationResult {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) {
    return { ok: false, reason: "not-aligned", message: "That is not a valid time." };
  }

  const startMin = minutesOfDay(start);
  if (startMin % SLOT_ALIGN_MINUTES !== 0) {
    return { ok: false, reason: "not-aligned", message: "Lessons start on the quarter hour." };
  }

  const candidates = evaluateCandidates(req);
  const match = candidates.find(c => c.startMin === startMin);
  if (!match) {
    return { ok: false, reason: "outside-window", message: "That time is outside the coach's hours." };
  }
  if (!match.ok) {
    return { ok: false, reason: match.reason ?? "outside-window", message: rejectMessage(match) };
  }

  const label = minutesToTime(match.startMin);
  return {
    ok: true,
    slot: {
      start: dayTimeToUtc(req.date, label).toISOString(),
      end: dayTimeToUtc(req.date, minutesToTime(match.endMin)).toISOString(),
      label,
      deadAfter: match.deadAfter,
      closesGap: match.deadAfter < match.deadBefore
    }
  };
}

function rejectMessage(c: Candidate): string {
  switch (c.reason) {
    case "overlap":
      return "That time has just been taken.";
    case "past-book-cutoff":
      return `Bookings close ${BOOK_CUTOFF_HOURS} hours before the lesson.`;
    case "too-much-dead-time":
      return "That time would leave too big a gap in the coach's day.";
    case "day-closed":
      return "The coach is not teaching that day.";
    default:
      return "That time is not available.";
  }
}

function overlapsAny(intervals: Interval[], startMin: number, endMin: number): boolean {
  return intervals.some(i => startMin < i.endMin && endMin > i.startMin);
}

/* =====================================================================
   Timing rules
   ===================================================================== */

/**
 * Cancellation closes 12 hours earlier than booking, deliberately: any
 * hole a cancellation creates still has half a day of booking time left
 * to fill it. Were both cutoffs 24h, a cancellation at the deadline
 * would leave a gap nobody could ever close.
 *
 * The cost is a band where a booking cannot be undone — anything booked
 * between -36h and -24h is final once its 30 minutes expire. That must
 * be visible at confirmation, not discovered afterwards.
 */
export function canCancel(
  lessonStart: Date,
  graceUntil: string | null | undefined,
  now: Date
): { allowed: boolean; viaGrace: boolean } {
  const cutoff = lessonStart.getTime() - CANCEL_CUTOFF_HOURS * 3_600_000;
  if (now.getTime() <= cutoff) return { allowed: true, viaGrace: false };

  if (graceUntil) {
    const grace = new Date(graceUntil);
    if (!Number.isNaN(grace.getTime()) && now.getTime() <= grace.getTime()) {
      return { allowed: true, viaGrace: true };
    }
  }
  return { allowed: false, viaGrace: false };
}

export function canBook(lessonStart: Date, now: Date): boolean {
  return lessonStart.getTime() - now.getTime() >= BOOK_CUTOFF_HOURS * 3_600_000;
}

/** True when booking this slot now means it can never be cancelled once
 *  the grace period expires — the warning the confirmation step shows. */
export function isFinalOnceGraceExpires(lessonStart: Date, now: Date): boolean {
  return now.getTime() > lessonStart.getTime() - CANCEL_CUTOFF_HOURS * 3_600_000;
}
