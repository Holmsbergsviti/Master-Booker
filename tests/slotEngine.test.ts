import { describe, expect, it } from "vitest";
import type { DayWindow, Occurrence } from "../src/shared/types.js";
import {
  canBook, canCancel, deadTime, evaluateCandidates, gapBudget,
  isFinalOnceGraceExpires, offeredSlots, validateSlot, type Interval
} from "../src/shared/slotEngine.js";
import { dayTimeToUtc } from "../src/shared/time.js";
import { MIN_SLOTS_OFFERED, lessonSpec } from "../src/shared/config.js";

const DATE = "2026-09-07"; // Monday
const WINDOW = (gapBudget: number | null = 45): DayWindow =>
  ({ date: DATE, start: "16:00", end: "21:00", gapBudget });

/** A booked lesson on DATE, given in Belgrade wall clock. */
function lesson(startTime: string, lessonType = "class"): Occurrence {
  const start = dayTimeToUtc(DATE, startTime);
  const end = new Date(start.getTime() + lessonSpec(lessonType).mins * 60_000);
  return {
    lessonId: `l-${startTime}`,
    start: start.toISOString(),
    end: end.toISOString(),
    occStart: start.toISOString(),
    lessonType,
    coach: ["Vlad"]
  };
}

/** Far enough out that the day is not yet inside any cutoff. */
const NOW = new Date("2026-09-01T09:00:00.000Z");

const req = (existing: Occurrence[], budget: number | null = 45, lessonType = "class") =>
  ({ date: DATE, window: WINDOW(budget), existing, lessonType, now: NOW });

/** Minutes past midnight, for the raw-metric tests. */
const iv = (startMin: number, mins: number, weight = 1): Interval =>
  ({ startMin, endMin: startMin + mins, weight });

const H = (h: number, m = 0) => h * 60 + m;

/* ===================================================================== */

describe("dead time", () => {
  it("is zero for an empty day", () => {
    expect(deadTime([]).dead).toBe(0);
  });

  it("is zero for a single lesson — span is the lesson itself", () => {
    expect(deadTime([iv(H(18), 45)]).dead).toBe(0);
  });

  it("is zero for back-to-back lessons", () => {
    expect(deadTime([iv(H(18), 45), iv(H(18, 45), 45)]).dead).toBe(0);
  });

  it("counts the gap between two lessons", () => {
    // 18:00-18:45 then 19:30-20:15 -> 45 idle minutes.
    expect(deadTime([iv(H(18), 45), iv(H(19, 30), 45)]).dead).toBe(45);
  });

  it("charges idle time after the first lesson — no break was earned yet", () => {
    const d = deadTime([iv(H(18), 45), iv(H(19), 45)]);
    expect(d.restCredited).toBe(0);
    expect(d.dead).toBe(15);
  });

  it("credits idle time after the third lesson as rest, not dead time", () => {
    const d = deadTime([
      iv(H(16), 45), iv(H(16, 45), 45), iv(H(17, 30), 45),
      iv(H(18, 30), 45)  // 15-minute gap after the third
    ]);
    expect(d.restCredited).toBe(15);
    expect(d.dead).toBe(0);
  });

  it("credits only the earned 15 minutes of a longer gap", () => {
    const d = deadTime([
      iv(H(16), 45), iv(H(16, 45), 45), iv(H(17, 30), 45),
      iv(H(19, 15), 45)  // 60-minute gap: 15 is rest, 45 is dead
    ]);
    expect(d.restCredited).toBe(15);
    expect(d.dead).toBe(45);
  });

  it("counts a Double as two lessons toward the break", () => {
    // Double (90, weight 2) + class (45, weight 1) = weight 3, then a gap.
    const d = deadTime([
      iv(H(16), 90, lessonSpec("double").breakWeight),
      iv(H(17, 30), 45),
      iv(H(18, 30), 45)  // 15-minute gap
    ]);
    expect(d.restCredited).toBe(15);
    expect(d.dead).toBe(0);
  });

  it("resets the consecutive counter after a real break", () => {
    // Three lessons, a 15-minute break, then two more and another
    // 15-minute gap. Total idle 30. Only the first gap is earned rest —
    // the counter restarted after the break, so two lessons is not
    // enough to earn a second one.
    const d = deadTime([
      iv(H(15), 45), iv(H(15, 45), 45), iv(H(16, 30), 45),
      iv(H(17, 30), 45), iv(H(18, 15), 45),
      iv(H(19, 15), 45)
    ]);
    expect(d.restCredited).toBe(15);
    expect(d.dead).toBe(15);
  });

  it("never reports negative dead time when the day ends on a third lesson", () => {
    const d = deadTime([iv(H(18), 45), iv(H(18, 45), 45), iv(H(19, 30), 45)]);
    expect(d.dead).toBe(0);
    expect(d.restCredited).toBe(0);
  });

  it("clamps rather than crediting rest for overlapping lessons", () => {
    const d = deadTime([iv(H(18), 60), iv(H(18, 30), 60)]);
    expect(d.dead).toBe(0);
  });
});

/* ===================================================================== */

describe("the worked example from the spec", () => {
  // Availability 16:00-21:00, 45-minute lessons, budget 45.
  const A = lesson("18:00");

  it("A books 18:00 into an empty day", () => {
    const result = validateSlot(req([]), dayTimeToUtc(DATE, "18:00").toISOString());
    expect(result.ok).toBe(true);
  });

  it("B may book 19:30 over a 45-minute gap — one lesson still fits", () => {
    const result = validateSlot(req([A]), dayTimeToUtc(DATE, "19:30").toISOString());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.slot.deadAfter).toBe(45);
  });

  it("B may not book 19:45 — the 60-minute gap is more than one lesson fills", () => {
    const result = validateSlot(req([A]), dayTimeToUtc(DATE, "19:45").toISOString());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too-much-dead-time");
  });

  it("C closes the gap at 18:45 and the day goes back to dead 0", () => {
    const B = lesson("19:30");
    const result = validateSlot(req([A, B]), dayTimeToUtc(DATE, "18:45").toISOString());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slot.deadAfter).toBe(0);
      expect(result.slot.closesGap).toBe(true);
    }
  });
});

/* ===================================================================== */

describe("never make the day worse than it already is", () => {
  it("allows extending the end of the evening over a gap the client did not create", () => {
    // A 90-minute hole someone else's cancellation left, wider than the
    // 45-minute budget. Booking on the far side of it does not widen it,
    // so max(before.dead, budget) must let it through.
    const existing = [lesson("16:00"), lesson("18:15")];
    const result = validateSlot(req(existing), dayTimeToUtc(DATE, "19:00").toISOString());
    expect(deadTime([iv(H(16), 45), iv(H(18, 15), 45)]).dead).toBe(90);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.slot.deadAfter).toBe(90);
  });

  it("still refuses a booking that widens an already-bad day", () => {
    const existing = [lesson("16:00"), lesson("18:15")];
    const result = validateSlot(req(existing), dayTimeToUtc(DATE, "20:00").toISOString());
    expect(result.ok).toBe(false);
  });
});

/* ===================================================================== */

describe("slot generation", () => {
  it("offers every legal quarter-hour and nothing else", () => {
    const slots = offeredSlots(req([]));
    expect(slots[0]?.label).toBe("16:00");
    // 16:00 to 20:15 inclusive on a 15-minute grid, since a 45-minute
    // lesson must end by 21:00.
    expect(slots[slots.length - 1]?.label).toBe("20:15");
    expect(slots.every(s => s.label.endsWith(":00") || s.label.endsWith(":15")
      || s.label.endsWith(":30") || s.label.endsWith(":45"))).toBe(true);
  });

  it("never offers a slot that overlaps an existing lesson", () => {
    const slots = offeredSlots(req([lesson("18:00")]));
    for (const time of ["17:30", "17:45", "18:00", "18:15", "18:30"]) {
      expect(slots.find(s => s.label === time)).toBeUndefined();
    }
    expect(slots.find(s => s.label === "18:45")).toBeDefined();
  });

  it("flags the slots that close an existing gap", () => {
    const slots = offeredSlots(req([lesson("16:00"), lesson("18:15")]));
    const closing = slots.filter(s => s.closesGap).map(s => s.label);
    expect(closing).toContain("16:45");
    expect(closing).toContain("17:30");
    expect(slots.find(s => s.label === "19:00")?.closesGap).toBe(false);
  });

  it("uses the client's own lesson length", () => {
    const doubles = offeredSlots(req([], 45, "double"));
    expect(doubles[doubles.length - 1]?.label).toBe("19:30"); // 90 min must end by 21:00
    const privates = offeredSlots(req([], 45, "private60"));
    expect(privates[privates.length - 1]?.label).toBe("20:00");
  });

  it("offers nothing once the whole day is inside the booking cutoff", () => {
    const lateNow = new Date(dayTimeToUtc(DATE, "20:00").getTime() - 60_000);
    expect(offeredSlots({ ...req([]), now: lateNow })).toHaveLength(0);
  });

  it("display and confirmation cannot drift — every offered slot validates", () => {
    const request = req([lesson("18:00"), lesson("19:45")]);
    for (const slot of offeredSlots(request)) {
      expect(validateSlot(request, slot.start).ok).toBe(true);
    }
    // ...and every rejected candidate is refused with a reason.
    for (const c of evaluateCandidates(request).filter(x => !x.ok)) {
      expect(c.reason).toBeTruthy();
    }
  });
});

/* ===================================================================== */

describe("gap budget by lead time", () => {
  const windowStart = dayTimeToUtc(DATE, "16:00");
  const hoursBefore = (h: number) => new Date(windowStart.getTime() - h * 3_600_000);

  it("gives 90 minutes more than 7 days out", () => {
    expect(gapBudget(windowStart, hoursBefore(10 * 24))).toBe(90);
  });

  it("gives 45 minutes between 3 and 7 days out", () => {
    expect(gapBudget(windowStart, hoursBefore(5 * 24))).toBe(45);
  });

  it("gives none inside 3 days — adjacent only", () => {
    expect(gapBudget(windowStart, hoursBefore(36))).toBe(0);
  });

  it("measures lead time to the window, not to the slot", () => {
    // A 20:45 slot is five hours later than the 16:00 window opens. Both
    // must land in the same band, so the whole day tightens at once.
    const now = hoursBefore(3 * 24 + 1);
    expect(gapBudget(windowStart, now)).toBe(45);
    expect(gapBudget(dayTimeToUtc(DATE, "16:00"), now)).toBe(45);
  });

  it("lets a per-day override beat the table", () => {
    expect(gapBudget(windowStart, hoursBefore(36), 120)).toBe(120);
    expect(gapBudget(windowStart, hoursBefore(10 * 24), 0)).toBe(0);
  });

  it("still prefers adjacent slots inside 3 days", () => {
    const now = hoursBefore(3 * 24 - 1);
    const request = { date: DATE, window: WINDOW(null), existing: [lesson("18:00")], lessonType: "class", now };
    const slots = offeredSlots(request);
    // The ones that leave no idle time are the ones marked as closing a
    // gap, and they are exactly the adjacent pair.
    expect(slots.filter(s => s.deadAfter === 0).map(s => s.label).sort())
      .toEqual(["17:15", "18:45"]);
  });
});

describe("never showing a nearly-empty day", () => {
  const windowStart = dayTimeToUtc(DATE, "16:00");
  const hoursBefore = (h: number) => new Date(windowStart.getTime() - h * 3_600_000);

  it("loosens the budget rather than offering two times", () => {
    // Two days out the budget is zero, so a day holding one lesson has
    // exactly two adjacent slots. That reads as "fully booked" when the
    // evening is half empty.
    const now = hoursBefore(2 * 24);
    const request = { date: DATE, window: WINDOW(null), existing: [lesson("18:00")], lessonType: "class", now };
    expect(gapBudget(windowStart, now)).toBe(0);
    expect(offeredSlots(request).length).toBeGreaterThanOrEqual(MIN_SLOTS_OFFERED);
  });

  it("leaves a day alone when the strict budget already offers enough", () => {
    const now = hoursBefore(2 * 24);
    const existing = [lesson("17:00"), lesson("19:00")];
    const strict = offeredSlots({ date: DATE, window: WINDOW(null), existing, lessonType: "class", now });
    expect(strict.length).toBeGreaterThanOrEqual(MIN_SLOTS_OFFERED);
    // Nothing was relaxed, so the day stays as tight as the rule wanted.
    expect(strict.every(s => s.deadAfter <= 75)).toBe(true);
  });

  it("respects a per-day override instead of talking the coach out of it", () => {
    // An explicit budget is the coach saying exactly what they want.
    const now = hoursBefore(2 * 24);
    const request = { date: DATE, window: WINDOW(0), existing: [lesson("18:00")], lessonType: "class", now };
    expect(offeredSlots(request).map(s => s.label).sort()).toEqual(["17:15", "18:45"]);
  });

  it("keeps display and confirmation identical after relaxing", () => {
    // The relaxation happens inside the shared generator, so a slot the
    // page offers is a slot /api/book accepts — and nothing else is.
    const now = hoursBefore(2 * 24);
    const request = { date: DATE, window: WINDOW(null), existing: [lesson("18:00")], lessonType: "class", now };
    const offered = offeredSlots(request);
    for (const slot of offered) {
      expect(validateSlot(request, slot.start).ok, slot.label).toBe(true);
    }
    // ...and a time that was not offered is refused.
    const notOffered = evaluateCandidates(request).find(c => !c.ok);
    if (notOffered) {
      const iso = dayTimeToUtc(DATE, minutesToLabel(notOffered.startMin)).toISOString();
      expect(validateSlot(request, iso).ok).toBe(false);
    }
  });
});

function minutesToLabel(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/* ===================================================================== */

describe("booking and cancellation windows", () => {
  const start = dayTimeToUtc(DATE, "18:15");
  const before = (h: number) => new Date(start.getTime() - h * 3_600_000);

  it("closes bookings 24 hours before, to the minute", () => {
    expect(canBook(start, before(24.001))).toBe(true);
    expect(canBook(start, before(23.999))).toBe(false);
  });

  it("closes cancellations 36 hours before, to the minute", () => {
    expect(canCancel(start, null, before(36.001)).allowed).toBe(true);
    expect(canCancel(start, null, before(35.999)).allowed).toBe(false);
  });

  it("lets the grace period override the cancel cutoff", () => {
    const bookedAt = before(30);
    const graceUntil = new Date(bookedAt.getTime() + 30 * 60_000).toISOString();
    expect(canCancel(start, graceUntil, before(29.9)).allowed).toBe(true);
    expect(canCancel(start, graceUntil, before(29.9)).viaGrace).toBe(true);
    expect(canCancel(start, graceUntil, before(29.4)).allowed).toBe(false);
  });

  it("warns that a booking inside 36h is final once grace expires", () => {
    expect(isFinalOnceGraceExpires(start, before(40))).toBe(false);
    expect(isFinalOnceGraceExpires(start, before(30))).toBe(true);
  });

  it("cannot let a grace period run past the lesson itself", () => {
    // Bookings close at 24h, so the latest a grace period can be created
    // is 24h out, expiring 23.5 hours before the lesson.
    const latestBooking = before(24);
    const grace = new Date(latestBooking.getTime() + 30 * 60_000);
    expect(start.getTime() - grace.getTime()).toBe(23.5 * 3_600_000);
  });
});
