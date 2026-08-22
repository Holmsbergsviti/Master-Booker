import { describe, expect, it } from "vitest";
import {
  addDayKey, addDaysWallClock, dayKey, dayTimeToUtc, daysBetweenKeys,
  formatTime, minutesOfDay, minutesToTime, timeToMinutes, weekStartMonday, weekdayOfKey
} from "../src/shared/time.js";

describe("Belgrade wall clock", () => {
  it("reads a stored UTC instant as Belgrade time", () => {
    // The spec's own example: 16:15Z is an 18:15 lesson (summer, UTC+2).
    expect(formatTime(new Date("2026-04-16T16:15:00.000Z"))).toBe("18:15");
  });

  it("reads a winter instant an hour differently (UTC+1)", () => {
    expect(formatTime(new Date("2026-12-10T17:15:00.000Z"))).toBe("18:15");
  });

  it("does not depend on the runtime timezone", () => {
    const utc = dayTimeToUtc("2026-09-07", "18:15");
    expect(utc.toISOString()).toBe("2026-09-07T16:15:00.000Z");
  });

  it("round-trips wall clock through UTC", () => {
    for (const date of ["2026-09-07", "2026-11-20", "2027-03-30"]) {
      for (const time of ["16:00", "18:15", "20:45"]) {
        expect(formatTime(dayTimeToUtc(date, time))).toBe(time);
        expect(dayKey(dayTimeToUtc(date, time))).toBe(date);
      }
    }
  });

  it("converts wall-clock strings both ways", () => {
    expect(timeToMinutes("16:00")).toBe(960);
    expect(minutesToTime(960)).toBe("16:00");
    expect(minutesToTime(1245)).toBe("20:45");
    expect(minutesOfDay(new Date("2026-04-16T16:15:00.000Z"))).toBe(18 * 60 + 15);
  });
});

describe("day keys", () => {
  it("shifts across month and year boundaries", () => {
    expect(addDayKey("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDayKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDayKey("2026-09-01", -1)).toBe("2026-08-31");
  });

  it("counts whole days between keys", () => {
    expect(daysBetweenKeys("2026-09-01", "2026-09-08")).toBe(7);
    expect(daysBetweenKeys("2026-09-08", "2026-09-01")).toBe(-7);
    // Spans the October DST change — still 31 calendar days.
    expect(daysBetweenKeys("2026-10-15", "2026-11-15")).toBe(31);
  });

  it("knows the weekday", () => {
    expect(weekdayOfKey("2026-09-07")).toBe(1); // Monday
    expect(weekdayOfKey("2026-09-13")).toBe(0); // Sunday
  });
});

describe("daylight saving", () => {
  // Belgrade goes back to UTC+1 on the last Sunday of October (25 Oct 2026).
  it("keeps the wall clock when advancing a week across the change", () => {
    const before = dayTimeToUtc("2026-10-22", "18:15"); // Thursday, UTC+2
    const after = addDaysWallClock(before, 7);          // Thursday, UTC+1
    expect(formatTime(after)).toBe("18:15");
    expect(after.toISOString()).toBe("2026-10-29T17:15:00.000Z");
  });

  it("does not preserve the UTC instant across the change", () => {
    // The point of the previous test: naive +7*24h arithmetic would give
    // 16:15Z, which reads as 17:15 in Belgrade — an hour wrong.
    const before = dayTimeToUtc("2026-10-22", "18:15");
    const naive = new Date(before.getTime() + 7 * 86_400_000);
    expect(formatTime(naive)).toBe("17:15");
    expect(formatTime(addDaysWallClock(before, 7))).not.toBe(formatTime(naive));
  });

  it("finds Monday midnight Belgrade for any day of the week", () => {
    const monday = weekStartMonday(dayTimeToUtc("2026-09-10", "18:15")); // Thursday
    expect(dayKey(monday)).toBe("2026-09-07");
    expect(formatTime(monday)).toBe("00:00");
  });
});
