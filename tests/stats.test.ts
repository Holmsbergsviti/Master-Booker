import { describe, expect, it } from "vitest";
import type { AvailabilityDoc, BookingLogDoc, DayIndexDoc } from "../src/shared/types.js";
import {
  clientStats, coachStats, currentSeason, formatHours, seasonOf, seasonsAvailable
} from "../src/shared/stats.js";
import { dayTimeToUtc } from "../src/shared/time.js";
import { lessonSpec } from "../src/shared/config.js";

function lesson(date: string, time: string, type: string, clientId: string | null, title = "X") {
  const start = dayTimeToUtc(date, time);
  return {
    lessonId: `${date}-${time}`,
    start: start.toISOString(),
    end: new Date(start.getTime() + lessonSpec(type).mins * 60_000).toISOString(),
    occStart: start.toISOString(),
    lessonType: type,
    coach: ["Vlad"],
    title,
    clientId
  };
}

const days: DayIndexDoc[] = [
  { date: "2026-09-07", rebuiltAt: "", lessons: [
    lesson("2026-09-07", "16:00", "class", "c1", "Zoran"),
    lesson("2026-09-07", "16:45", "class", "c1", "Zoran"),
    lesson("2026-09-07", "18:00", "double", null, "Mladenci")
  ] },
  { date: "2026-09-08", rebuiltAt: "", lessons: [] },
  { date: "2026-10-05", rebuiltAt: "", lessons: [
    lesson("2026-10-05", "17:00", "private60", "c2", "Karina")
  ] },
  // Before the epoch: must not be counted at all.
  { date: "2026-08-20", rebuiltAt: "", lessons: [
    lesson("2026-08-20", "17:00", "class", "c1", "Zoran")
  ] }
];

const availability: AvailabilityDoc[] = [
  { weekday: 1, start: "16:00", end: "21:00", validFrom: "2026-09-01" }, // Monday
  { date: "2026-10-05", start: "16:00", end: "20:00" }
];

const cancellations: BookingLogDoc[] = [
  { clientId: "c1", lessonId: "x", start: dayTimeToUtc("2026-09-21", "18:00").toISOString(),
    end: "", lessonType: "class", cancelledAt: "", cancelledBy: "client" }
];

describe("seasons", () => {
  it("starts a new season in September", () => {
    expect(seasonOf("2026-09-01").startYear).toBe(2026);
    expect(seasonOf("2027-08-31").startYear).toBe(2026);
    expect(seasonOf("2027-09-01").startYear).toBe(2027);
  });

  it("never reaches back past the epoch", () => {
    expect(seasonOf("2026-09-15").from).toBe("2026-09-01");
  });

  it("offers every season from the epoch to now, newest first", () => {
    const list = seasonsAvailable(new Date("2027-10-01T12:00:00Z"));
    expect(list.map(s => s.startYear)).toEqual([2027, 2026]);
  });

  it("never offers an empty list before the first season opens", () => {
    // August 2026 falls in the 2025/26 season by the calendar, which
    // this system has no data for. The picker must still offer the one
    // real season rather than rendering blank.
    const list = seasonsAvailable(new Date("2026-08-22T12:00:00Z"));
    expect(list.map(s => s.startYear)).toEqual([2026]);
  });

  it("opens on the first real season when today predates the epoch", () => {
    // seasonOf() alone would say 2025/26, whose range clamps to a start
    // after its own end — a season that can never contain anything.
    expect(seasonOf("2026-08-22").startYear).toBe(2025);
    expect(currentSeason(new Date("2026-08-22T12:00:00Z")).startYear).toBe(2026);
    expect(currentSeason(new Date("2026-10-01T12:00:00Z")).startYear).toBe(2026);
    expect(currentSeason(new Date("2027-09-05T12:00:00Z")).startYear).toBe(2027);
  });
});

describe("coach statistics", () => {
  const stats = coachStats({
    season: seasonOf("2026-09-07"),
    days, cancellations, availability,
    clientNames: new Map([["c1", "Zoran"], ["c2", "Karina"]]),
    through: "2026-10-31"
  });

  it("counts lessons and hours in the season only", () => {
    // Three on 7 Sep + one on 5 Oct. The 20 August lesson predates the
    // epoch and must not appear.
    expect(stats.total.count).toBe(4);
    expect(stats.total.minutes).toBe(45 + 45 + 90 + 60);
  });

  it("splits by type", () => {
    expect(stats.total.byType).toEqual({ class: 2, double: 1, private60: 1 });
  });

  it("groups by month", () => {
    expect(stats.byMonth.map(m => m.key)).toEqual(["2026-09", "2026-10"]);
    expect(stats.byMonth[0]!.count).toBe(3);
  });

  it("attributes lessons to clients, and unmatched ones to their title", () => {
    const zoran = stats.byClient.find(c => c.clientId === "c1")!;
    expect(zoran.count).toBe(2);
    // A hand-entered lesson with no clientId still shows, under its title,
    // so the coach's own totals need no backfill.
    const unmatched = stats.byClient.find(c => c.clientId === null)!;
    expect(unmatched.label).toBe("Mladenci");
  });

  it("computes window utilisation against hours actually offered", () => {
    // Mondays 7, 14, 21, 28 September and 5, 12, 19, 26 October at 5h,
    // except 5 October which has a 4h dated override.
    expect(stats.utilisation.offeredMinutes).toBe(7 * 300 + 240);
    expect(stats.utilisation.bookedMinutes).toBe(240);
    expect(stats.utilisation.ratio).toBeCloseTo(240 / (7 * 300 + 240), 5);
  });

  it("reports the idle time absorbed", () => {
    // 7 Sep: 16:00-16:45, 16:45-17:30, 18:00-19:30 -> a 30-minute hole.
    expect(stats.utilisation.idleMinutes).toBe(30);
  });

  it("counts cancellations without resurrecting them as lessons", () => {
    expect(stats.cancellations.total).toBe(1);
    expect(stats.cancellations.byClient.c1).toBe(1);
    expect(stats.total.count).toBe(4);
  });
});

describe("client statistics", () => {
  it("shows an upcoming lesson booked before the season opens", () => {
    // The index reaches back before the season so those dates can be
    // booked. If the season filter also governed the upcoming list, the
    // booking would succeed and then be invisible.
    const beforeSeason: DayIndexDoc[] = [{
      date: "2026-08-26", rebuiltAt: "", lessons: [
        lesson("2026-08-26", "18:30", "class", "c9", "Early Bird")
      ]
    }];
    const stats = clientStats("c9", beforeSeason, [], seasonOf("2026-09-07"),
      new Date("2026-08-22T12:00:00.000Z"));

    expect(stats.upcoming).toHaveLength(1);
    // ...but it still does not count toward the season's totals.
    expect(stats.total.count).toBe(0);
  });


  const now = new Date("2026-09-20T12:00:00.000Z");
  const stats = clientStats("c1", days, cancellations, seasonOf("2026-09-07"), now);

  it("counts only that client's own lessons", () => {
    expect(stats.total.count).toBe(2);
    expect(stats.total.minutes).toBe(90);
  });

  it("separates lessons already taken from what is still upcoming", () => {
    const upcoming = clientStats("c2", days, cancellations, seasonOf("2026-09-07"), now);
    expect(upcoming.total.count).toBe(0);
    expect(upcoming.upcoming).toHaveLength(1);
  });

  it("counts their own cancellations", () => {
    expect(stats.cancellations).toBe(1);
  });
});

describe("formatting", () => {
  it("reads minutes as hours", () => {
    expect(formatHours(0)).toBe("0m");
    expect(formatHours(45)).toBe("45m");
    expect(formatHours(60)).toBe("1h");
    expect(formatHours(270)).toBe("4h 30m");
  });
});
