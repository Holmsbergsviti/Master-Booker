import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExceptionDoc, LessonDoc } from "../src/shared/types.js";
import { expandOccurrences } from "../src/shared/expand.js";
import {
  affectedDayKeys, buildDayIndex, dayKeysBetween, groupByDay, indexRange, isStale
} from "../src/shared/dayIndex.js";
import { dayKey, dayTimeToUtc, formatTime } from "../src/shared/time.js";
import {
  buildCancelledSet, buildLessonCache, fingerprint, occurrencesInRange
} from "./reference/calendarExpansion.js";

/* ---------- fixtures, in Belgrade wall clock ---------- */

let seq = 0;
function makeLesson(
  date: string, time: string, mins: number, extra: Partial<LessonDoc> = {}
): LessonDoc {
  const start = dayTimeToUtc(date, time);
  return {
    id: `L${++seq}`,
    coach: ["Vlad"],
    title: "Fixture",
    lessonType: "class",
    start: start.toISOString(),
    end: new Date(start.getTime() + mins * 60_000).toISOString(),
    occStart: start.toISOString(),
    ...extra
  };
}

/** Every fixture shape Phase 1 has to get right at once. */
function fixtures(): { lessons: LessonDoc[]; exceptions: ExceptionDoc[] } {
  seq = 0;
  const weekly = makeLesson("2026-09-10", "18:15", 45, { repeatWeekly: true }); // Thursday
  const weeklyDouble = makeLesson("2026-09-08", "16:00", 90, {
    repeatWeekly: true, lessonType: "double"
  });
  const ending = makeLesson("2026-09-07", "19:00", 45, {
    repeatWeekly: true,
    repeatEndDate: dayTimeToUtc("2026-10-05", "23:59").toISOString()
  });
  const oneOff = makeLesson("2026-09-15", "17:00", 60, { lessonType: "group" });
  const shared = makeLesson("2026-09-16", "20:00", 45, { coach: ["Vlad", "Ana"] });
  const otherCoach = makeLesson("2026-09-17", "18:00", 45, { coach: ["Ana"] });
  // A series split by "edit all future": the child is an ordinary
  // standalone document that carries only lineage in parentId.
  const splitChild = makeLesson("2026-11-05", "19:30", 45, {
    repeatWeekly: true, parentId: weekly.id
  });

  const lessons = [weekly, weeklyDouble, ending, oneOff, shared, otherCoach, splitChild];

  const exceptions: ExceptionDoc[] = [
    // Cancel one occurrence of the weekly series, after the DST change.
    { parentId: weekly.id, occStart: dayTimeToUtc("2026-11-12", "18:15").toISOString(), type: "cancel" },
    // ...and one before it.
    { parentId: weekly.id, occStart: dayTimeToUtc("2026-09-24", "18:15").toISOString(), type: "cancel" },
    // A type the booking site must ignore rather than guess at.
    { parentId: weeklyDouble.id, occStart: dayTimeToUtc("2026-09-15", "16:00").toISOString(), type: "moved" }
  ];

  return { lessons, exceptions };
}

/* ===================================================================== */

describe("agreement with the calendar app", () => {
  // The reference implementation uses the runtime's local zone, exactly
  // as the browser does. Point it at Belgrade and it is the coach's view.
  const originalTz = process.env.TZ;
  beforeAll(() => { process.env.TZ = "Europe/Belgrade"; });
  afterAll(() => { process.env.TZ = originalTz; });

  const { lessons, exceptions } = fixtures();
  const cache = buildLessonCache(lessons);
  const cancelled = buildCancelledSet(exceptions);

  /** Six-week spans, which is what a month view actually asks for and
   *  what the reference's 64-iteration cap is sized for. */
  const spans: Array<[string, string, string]> = [
    ["September", "2026-08-31", "2026-10-05"],
    ["across the October DST change", "2026-09-28", "2026-11-09"],
    ["November", "2026-10-26", "2026-12-07"],
    ["across the March DST change", "2027-03-01", "2027-04-12"]
  ];

  for (const [label, from, to] of spans) {
    it(`matches over ${label}`, () => {
      const rangeStart = dayTimeToUtc(from, "00:00");
      const rangeEnd = dayTimeToUtc(to, "00:00");

      const theirs = fingerprint(occurrencesInRange(cache, cancelled, rangeStart, rangeEnd));
      const mine = expandOccurrences(lessons, exceptions, rangeStart, rangeEnd, { coach: null })
        .map(o => `${o.lessonId}@${o.start}`)
        .sort();

      expect(mine).toEqual(theirs);
      expect(mine.length).toBeGreaterThan(0);
    });
  }

  it("matches week by week for a whole season", () => {
    for (let week = 0; week < 52; week++) {
      const rangeStart = new Date(dayTimeToUtc("2026-09-01", "00:00").getTime() + week * 7 * 86_400_000);
      const rangeEnd = new Date(rangeStart.getTime() + 7 * 86_400_000);
      const theirs = fingerprint(occurrencesInRange(cache, cancelled, rangeStart, rangeEnd));
      const mine = expandOccurrences(lessons, exceptions, rangeStart, rangeEnd, { coach: null })
        .map(o => `${o.lessonId}@${o.start}`)
        .sort();
      expect(mine, `week ${week} starting ${rangeStart.toISOString()}`).toEqual(theirs);
    }
  });
});

/* ===================================================================== */

describe("expansion", () => {
  const { lessons, exceptions } = fixtures();
  const range = (from: string, to: string) =>
    expandOccurrences(lessons, exceptions, dayTimeToUtc(from, "00:00"), dayTimeToUtc(to, "00:00"));

  it("keeps a weekly lesson at the same wall-clock time across the DST change", () => {
    const occ = range("2026-09-01", "2026-12-01").filter(o => o.lessonId === "L1");
    expect(occ.length).toBeGreaterThan(8);
    for (const o of occ) expect(formatTime(new Date(o.start))).toBe("18:15");
    // ...even though the stored UTC instant shifts by an hour.
    const october = occ.find(o => dayKey(new Date(o.start)) === "2026-10-22")!;
    const november = occ.find(o => dayKey(new Date(o.start)) === "2026-11-05")!;
    expect(october.start).toBe("2026-10-22T16:15:00.000Z");
    expect(november.start).toBe("2026-11-05T17:15:00.000Z");
  });

  it("carves out cancelled occurrences and nothing else", () => {
    const occ = range("2026-09-01", "2026-12-01").filter(o => o.lessonId === "L1");
    const days = occ.map(o => dayKey(new Date(o.start)));
    expect(days).not.toContain("2026-09-24");
    expect(days).not.toContain("2026-11-12");
    expect(days).toContain("2026-09-17");
    expect(days).toContain("2026-11-05");
  });

  it("ignores exception types it does not understand", () => {
    // Only `cancel` is written today. An unknown type must not silently
    // start deleting lessons from the index.
    const occ = range("2026-09-14", "2026-09-16").filter(o => o.lessonId === "L2");
    expect(occ).toHaveLength(1);
  });

  it("stops a series at repeatEndDate", () => {
    const occ = range("2026-09-01", "2026-12-01").filter(o => o.lessonId === "L3");
    const days = occ.map(o => dayKey(new Date(o.start)));
    expect(days).toContain("2026-10-05");
    expect(days.filter(d => d > "2026-10-05")).toHaveLength(0);
  });

  it("keeps a lesson the coach shares with someone else", () => {
    expect(range("2026-09-16", "2026-09-17").some(o => o.lessonId === "L5")).toBe(true);
  });

  it("drops lessons the coach is not on", () => {
    expect(range("2026-09-17", "2026-09-18").some(o => o.lessonId === "L6")).toBe(false);
  });

  it("expands a split-off child series like any other lesson", () => {
    const occ = range("2026-11-01", "2026-12-01").filter(o => o.lessonId === "L7");
    expect(occ.length).toBeGreaterThan(3);
    for (const o of occ) expect(formatTime(new Date(o.start))).toBe("19:30");
  });

  it("includes a lesson that started before the range but overlaps it", () => {
    const lesson = makeLesson("2026-09-20", "17:00", 90);
    const occ = expandOccurrences([lesson], [], dayTimeToUtc("2026-09-20", "18:00"),
      dayTimeToUtc("2026-09-20", "19:00"));
    expect(occ).toHaveLength(1);
  });

  it("skips documents with unusable dates rather than throwing", () => {
    const broken: LessonDoc = { id: "bad", coach: ["Vlad"], start: "not a date", end: "also not" };
    expect(() => expandOccurrences([broken], [], dayTimeToUtc("2026-09-01", "00:00"),
      dayTimeToUtc("2026-09-08", "00:00"))).not.toThrow();
    expect(expandOccurrences([broken], [], dayTimeToUtc("2026-09-01", "00:00"),
      dayTimeToUtc("2026-09-08", "00:00"))).toHaveLength(0);
  });
});

/* ===================================================================== */

describe("the day index", () => {
  const { lessons, exceptions } = fixtures();

  it("writes a document for every day in range, including empty ones", () => {
    const keys = dayKeysBetween("2026-09-07", "2026-09-13");
    const index = buildDayIndex(lessons, exceptions, keys);
    expect(index.map(d => d.date)).toEqual(keys);
    // An absent document and a free day must never be indistinguishable:
    // that would read as "nothing booked" and oversell the slot.
    const sunday = index.find(d => d.date === "2026-09-13")!;
    expect(sunday.lessons).toEqual([]);
  });

  it("puts each lesson on the Belgrade day it starts", () => {
    const index = buildDayIndex(lessons, exceptions, dayKeysBetween("2026-09-07", "2026-09-13"));
    const thursday = index.find(d => d.date === "2026-09-10")!;
    expect(thursday.lessons.map(l => l.lessonId)).toContain("L1");
    expect(thursday.lessons[0]!.title).toBe("Fixture");
  });

  it("sorts each day by start time", () => {
    const grouped = groupByDay(expandOccurrences(lessons, exceptions,
      dayTimeToUtc("2026-09-07", "00:00"), dayTimeToUtc("2026-09-21", "00:00")));
    for (const day of grouped.values()) {
      const starts = day.map(l => l.start);
      expect([...starts].sort()).toEqual(starts);
    }
  });

  it("indexes dates before the season opens, so they can be booked", () => {
    // The index used to start at the season epoch, which meant no date
    // before 1 September had a document — and a missing document is
    // treated as "not ready", never as "free", so nothing was bookable.
    const august = new Date("2026-08-22T10:00:00.000Z");
    const range = indexRange(august);
    expect(range.from).toBe("2026-08-22");
    expect(dayKeysBetween(range.from, range.to)).toContain("2026-08-25");

    // Once the season is under way it reaches back to the epoch instead,
    // because the statistics read these same documents.
    expect(indexRange(new Date("2026-10-15T10:00:00.000Z")).from).toBe("2026-09-01");
  });

  it("knows which days a save has to rebuild", () => {
    const now = new Date("2026-09-05T10:00:00.000Z");
    expect(affectedDayKeys({ start: dayTimeToUtc("2026-09-10", "18:15").toISOString() }, now))
      .toEqual(["2026-09-10"]);

    const repeating = affectedDayKeys({
      start: dayTimeToUtc("2026-09-10", "18:15").toISOString(),
      repeatWeekly: true
    }, now);
    expect(repeating[0]).toBe("2026-09-10");
    expect(repeating.length).toBeGreaterThan(80);

    // A lesson outside the indexed range touches nothing.
    expect(affectedDayKeys({ start: dayTimeToUtc("2027-06-01", "18:15").toISOString() }, now))
      .toEqual([]);
  });

  it("treats a missing or old rebuiltAt as stale", () => {
    const now = new Date("2026-09-05T10:00:00.000Z");
    expect(isStale(null, now)).toBe(true);
    expect(isStale("nonsense", now)).toBe(true);
    expect(isStale(new Date(now.getTime() - 10 * 60_000).toISOString(), now)).toBe(false);
    expect(isStale(new Date(now.getTime() - 90 * 60_000).toISOString(), now)).toBe(true);
  });
});
