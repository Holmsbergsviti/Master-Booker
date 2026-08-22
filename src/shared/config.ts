/* =====================================================================
   Configuration. Everything tunable lives here so that changing policy
   is an edit to one file rather than a search across the codebase.
   ===================================================================== */

/** v1 is one coach. Kept as a constant so adding a second is a config
 *  change, not a search-and-replace: every query filters on this. */
export const COACH = "Vlad";

/** Hardcoded, never the device timezone. A lesson at 18:15 reads as
 *  18:15 from Serbia, Berlin or Tokyo. */
export const TZ = "Europe/Belgrade";

export interface LessonTypeSpec {
  /** Minutes on the calendar. */
  mins: number;
  /** How much this lesson counts toward the 3-lessons-then-break rule.
   *  Configuration, not logic: set private60 to 1.5 and premium clients
   *  earn a break after two instead of three. */
  breakWeight: number;
  label: string;
  /** false for types the coach enters by hand but clients cannot book. */
  bookable: boolean;
}

export const LESSON_TYPES: Record<string, LessonTypeSpec> = {
  class:     { mins: 45, breakWeight: 1, label: "Class",   bookable: true },
  private60: { mins: 60, breakWeight: 1, label: "Private", bookable: true },
  group:     { mins: 60, breakWeight: 1, label: "Group",   bookable: false },
  double:    { mins: 90, breakWeight: 2, label: "Double",  bookable: true }
};

export const DEFAULT_LESSON_TYPE = "class";

/** Unknown types (hand-entered, or added to the calendar app later) must
 *  still occupy their slot rather than crashing the index. */
export function lessonSpec(type: string | undefined | null): LessonTypeSpec {
  return LESSON_TYPES[type ?? ""] ?? LESSON_TYPES[DEFAULT_LESSON_TYPE]!;
}

/* ---------- Breaks ---------- */

/** 15 minutes off after every 3 consecutive lessons, by weight. */
export const BREAK_MINUTES = 15;
export const LESSONS_PER_BREAK = 3;

/** Any idle stretch of at least this long resets the consecutive counter. */
export const BREAK_RESET_MINUTES = 15;

/* ---------- Gap budget ---------- */

/** Idle minutes a booking may leave behind, by lead time to the START of
 *  that day's availability window. Measuring to the window rather than to
 *  the slot means a whole day tightens at once, instead of early slots
 *  locking while late ones are still loose.
 *
 *  Ordered loosest-first; the first entry whose threshold the lead time
 *  clears wins. */
export const GAP_BUDGET_TABLE: ReadonlyArray<{ minLeadHours: number; budgetMinutes: number }> = [
  { minLeadHours: 7 * 24, budgetMinutes: 90 },
  { minLeadHours: 3 * 24, budgetMinutes: 45 },
  { minLeadHours: 0,      budgetMinutes: 0 }
];

/* ---------- Timing ---------- */

export const BOOK_CUTOFF_HOURS = 24;
export const CANCEL_CUTOFF_HOURS = 36;

/** A client's own booking stays cancellable this long no matter what. */
export const GRACE_MINUTES = 30;

/** A coach-side move grants a fresh cancellation right. Thirty minutes is
 *  too short here — the client did not initiate the change and may be
 *  asleep. Capped at the lesson start by the caller. */
export const COACH_CHANGE_GRACE_HOURS = 12;

/** Clients who tick the flexible box consent to being shifted this far. */
export const FLEXIBLE_SHIFT_MINUTES = 60;

/**
 * Never offer a day fewer times than this while a looser budget would
 * allow more.
 *
 * The lead-time table is right about packing the coach's day and wrong
 * about what a student should see: two days out the budget is zero, so a
 * day holding two lessons offers exactly the two slots touching them.
 * That reads as "fully booked" when the evening is half empty, and it
 * pushes people to ring up instead.
 *
 * So the budget is a starting point, not a floor. If it yields fewer
 * than this, it is loosened a rung at a time until it does — the day
 * still fills from the tightest end, because gap-closing slots are
 * marked and taken first.
 */
export const MIN_SLOTS_OFFERED = 3;

/** Budgets to fall back through when the day is too quiet. The last rung
 *  gives up on packing entirely rather than showing an empty day. */
export const BUDGET_RELAXATION: readonly number[] = [45, 90, 180, Infinity];

/* ---------- Slots ---------- */

/** Candidate start times are aligned to this grid. */
export const SLOT_ALIGN_MINUTES = 15;

/* ---------- Day index ---------- */

/** The statistics floor: nothing before this counts toward a season.
 *
 *  Deliberately NOT the start of the day index. The two were one
 *  constant, which meant no date before the season opened could be
 *  booked at all — the index simply had no document for it, and a
 *  missing document reads as "not ready", never as "free". Booking and
 *  statistics want different windows, so they get different constants. */
export const SEASON_EPOCH = "2026-09-01";

export const INDEX_FORWARD_DAYS = 90;

/** The booking page warns when the index it read is older than this. */
export const INDEX_STALE_MINUTES = 45;

/* ---------- Season ---------- */

/** A season runs 1 September -> 31 August. */
export const SEASON_START_MONTH_DAY = "09-01";
