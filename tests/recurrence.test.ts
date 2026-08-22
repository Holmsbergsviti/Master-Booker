import { describe, expect, it } from "vitest";
import type { DayWindow, Occurrence } from "../src/shared/types.js";
import { planWeekly } from "../src/shared/recurrence.js";
import { dayTimeToUtc, formatTime } from "../src/shared/time.js";
import { lessonSpec } from "../src/shared/config.js";

const WINDOW: DayWindow = { date: "", start: "16:00", end: "21:00", gapBudget: 45 };
const NOW = new Date("2026-09-01T09:00:00.000Z");

function booked(date: string, time: string, type = "class"): Occurrence {
  const start = dayTimeToUtc(date, time);
  return {
    lessonId: `${date}-${time}`,
    start: start.toISOString(),
    end: new Date(start.getTime() + lessonSpec(type).mins * 60_000).toISOString(),
    occStart: start.toISOString(),
    lessonType: type,
    coach: ["Vlad"]
  };
}

const plan = (opts: {
  from?: string; label?: string; horizon?: string;
  closed?: string[]; taken?: Record<string, Occurrence[]>; unbuilt?: string[];
} = {}) => planWeekly({
  firstDate: opts.from ?? "2026-09-07",
  startLabel: opts.label ?? "18:00",
  lessonType: "class",
  now: NOW,
  horizon: opts.horizon ?? "2026-10-19",
  windowFor: date => (opts.closed ?? []).includes(date) ? null : { ...WINDOW, date },
  existingFor: date => (opts.unbuilt ?? []).includes(date) ? null : (opts.taken?.[date] ?? [])
});

describe("planning a weekly booking", () => {
  it("lays out one occurrence a week up to the horizon", () => {
    const result = plan();
    expect(result.occurrences.map(o => o.date)).toEqual([
      "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28",
      "2026-10-05", "2026-10-12", "2026-10-19"
    ]);
    expect(result.blocked).toHaveLength(0);
  });

  it("never plans past the horizon", () => {
    const result = plan({ horizon: "2026-09-20" });
    expect(result.occurrences.map(o => o.date)).toEqual(["2026-09-07", "2026-09-14"]);
  });

  it("keeps the wall clock across the October daylight-saving change", () => {
    // Belgrade goes back to UTC+1 on 25 October 2026.
    const result = plan({ from: "2026-10-19", horizon: "2026-11-16" });
    for (const occurrence of result.occurrences) {
      expect(formatTime(new Date(occurrence.start))).toBe("18:00");
    }
    // The stored instant shifts by an hour, which is the point.
    expect(result.occurrences[0]!.start).toBe("2026-10-19T16:00:00.000Z");
    expect(result.occurrences[1]!.start).toBe("2026-10-26T17:00:00.000Z");
  });

  it("blocks the weeks that are already taken and keeps the rest", () => {
    // Someone else has 18:00 on the 21st.
    const result = plan({ taken: { "2026-09-21": [booked("2026-09-21", "18:00")] } });
    expect(result.bookable.map(o => o.date)).not.toContain("2026-09-21");
    expect(result.blocked.map(o => o.date)).toEqual(["2026-09-21"]);
    expect(result.bookable).toHaveLength(6);
    expect(result.blocked[0]!.reason).toBe("overlap");
  });

  it("blocks a week the coach is not teaching", () => {
    const result = plan({ closed: ["2026-09-28"] });
    expect(result.blocked.map(o => o.date)).toEqual(["2026-09-28"]);
    expect(result.blocked[0]!.reason).toBe("day-closed");
  });

  it("blocks a week where the booking would leave too big a gap", () => {
    // A lesson at 16:00 alone is fine; adding 18:00 leaves 75 idle
    // minutes, past the 45-minute budget.
    const result = plan({ taken: { "2026-10-05": [booked("2026-10-05", "16:00")] } });
    const blocked = result.blocked.find(o => o.date === "2026-10-05");
    expect(blocked?.reason).toBe("too-much-dead-time");
  });

  it("refuses the first week when it is inside the booking cutoff", () => {
    // Booked less than 24 hours before the first lesson.
    const late = planWeekly({
      firstDate: "2026-09-07",
      startLabel: "18:00",
      lessonType: "class",
      now: new Date("2026-09-07T09:00:00.000Z"),
      horizon: "2026-09-21",
      windowFor: date => ({ ...WINDOW, date }),
      existingFor: () => []
    });
    expect(late.occurrences[0]!.ok).toBe(false);
    expect(late.occurrences[0]!.reason).toBe("past-book-cutoff");
    // Later weeks are unaffected.
    expect(late.occurrences[1]!.ok).toBe(true);
  });

  it("refuses a week the index has not been built for", () => {
    // A missing day document is not an empty day. Booking against one
    // would be selling a slot nobody has checked.
    const result = plan({ unbuilt: ["2026-09-21"] });
    expect(result.bookable.map(o => o.date)).not.toContain("2026-09-21");
    expect(result.blocked[0]!.message).toMatch(/ready for booking/i);
  });

  it("reports nothing bookable rather than throwing when every week is closed", () => {
    const result = plan({ closed: [
      "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28",
      "2026-10-05", "2026-10-12", "2026-10-19"
    ] });
    expect(result.bookable).toHaveLength(0);
    expect(result.blocked).toHaveLength(7);
  });
});
