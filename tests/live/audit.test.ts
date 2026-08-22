/* =====================================================================
   Phase 1's real exit criterion.

   The other tests diff the expansion against a *copy* of the calendar
   app's algorithm on fixtures I wrote. This one runs both against the
   live database, which is the only thing that can tell me whether the
   documents actually look the way the calendar's source implies.

   Opt-in: needs serviceAccountKey.json, so it is excluded from the
   default suite. Read-only — it never writes.

       npm run test:live
   ===================================================================== */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cert, deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";
import type { ExceptionDoc, LessonDoc } from "../../src/shared/types.js";
import { expandOccurrences } from "../../src/shared/expand.js";
import { dayTimeToUtc } from "../../src/shared/time.js";
import {
  buildCancelledSet, buildLessonCache, fingerprint, occurrencesInRange
} from "../reference/calendarExpansion.js";

const key = JSON.parse(readFileSync("serviceAccountKey.json", "utf8"));
const app = initializeApp({
  credential: cert({
    projectId: key.project_id,
    clientEmail: key.client_email,
    privateKey: key.private_key
  })
}, `audit-${Date.now()}`);
const db = getFirestore(app);

let lessons: LessonDoc[] = [];
let exceptions: ExceptionDoc[] = [];

beforeAll(async () => {
  const [lessonSnap, exceptionSnap] = await Promise.all([
    db.collection("lessons").get(),
    db.collection("repeat_exceptions").get()
  ]);
  lessons = lessonSnap.docs.map(d => ({ ...(d.data() as Omit<LessonDoc, "id">), id: d.id }));
  exceptions = exceptionSnap.docs.map(d => ({ ...(d.data() as ExceptionDoc), id: d.id }));

  console.log(`\n  ${lessons.length} lessons, ${exceptions.length} exceptions\n`);
}, 60_000);

afterAll(() => deleteApp(app));

describe("what the documents actually look like", () => {
  it("reports the field shapes", () => {
    const report = {
      coachTypes: new Set<string>(),
      coaches: new Set<string>(),
      lessonTypes: new Map<string, number>(),
      exceptionTypes: new Map<string, number>(),
      repeatEndDate: 0,
      repeatUntil: 0,
      repeatWeekly: 0,
      parentId: 0,
      missingEnd: 0,
      invalidDates: 0,
      sourceBooking: 0,
      extraFields: new Set<string>()
    };

    const known = new Set([
      "coach", "start", "end", "occStart", "lessonType", "title",
      "repeatWeekly", "repeatEndDate", "parentId", "id",
      "clientId", "source", "flexible", "bookedAt", "graceUntil"
    ]);

    for (const l of lessons) {
      report.coachTypes.add(Array.isArray(l.coach) ? "array" : typeof l.coach);
      for (const c of Array.isArray(l.coach) ? l.coach : [l.coach]) {
        if (typeof c === "string") report.coaches.add(c);
      }
      const type = l.lessonType ?? "(absent)";
      report.lessonTypes.set(type, (report.lessonTypes.get(type) ?? 0) + 1);
      if (l.repeatWeekly) report.repeatWeekly++;
      if (l.repeatEndDate) report.repeatEndDate++;
      if ((l as unknown as Record<string, unknown>).repeatUntil) report.repeatUntil++;
      if (l.parentId) report.parentId++;
      if (!l.end) report.missingEnd++;
      if (l.source === "booking") report.sourceBooking++;
      if (Number.isNaN(new Date(l.start).getTime()) || Number.isNaN(new Date(l.end).getTime())) {
        report.invalidDates++;
      }
      for (const field of Object.keys(l)) if (!known.has(field)) report.extraFields.add(field);
    }

    for (const x of exceptions) {
      report.exceptionTypes.set(x.type, (report.exceptionTypes.get(x.type) ?? 0) + 1);
    }

    console.log("  coach field types :", [...report.coachTypes].join(", "));
    console.log("  coaches           :", [...report.coaches].join(", "));
    console.log("  lessonType counts :", Object.fromEntries(report.lessonTypes));
    console.log("  exception types   :", Object.fromEntries(report.exceptionTypes));
    console.log("  repeatWeekly      :", report.repeatWeekly);
    console.log("  repeatEndDate set :", report.repeatEndDate);
    console.log("  repeatUntil set   :", report.repeatUntil, "(spec guessed this name)");
    console.log("  parentId set      :", report.parentId);
    console.log("  missing end       :", report.missingEnd);
    console.log("  invalid dates     :", report.invalidDates);
    console.log("  source: booking   :", report.sourceBooking);
    console.log("  unexpected fields :", [...report.extraFields].join(", ") || "(none)");

    expect(lessons.length).toBeGreaterThan(0);
  });

  it("confirms the two Phase 0 questions", () => {
    const types = new Set(exceptions.map(x => x.type));
    // Anything other than "cancel" is a shape expand.ts deliberately
    // ignores, so it would be a silent behaviour change if one existed.
    expect([...types]).toEqual(exceptions.length > 0 ? ["cancel"] : []);
    // The spec guessed `repeatUntil`; the field is `repeatEndDate`.
    expect(lessons.some(l => (l as unknown as Record<string, unknown>).repeatUntil)).toBe(false);
  });
});

describe("the index matches the calendar, on real data", () => {
  const originalTz = process.env.TZ;
  beforeAll(() => { process.env.TZ = "Europe/Belgrade"; });
  afterAll(() => { process.env.TZ = originalTz; });

  it("agrees every week from the season start through the booking horizon", () => {
    const cache = buildLessonCache(lessons);
    const cancelled = buildCancelledSet(exceptions);

    let compared = 0;
    let occurrences = 0;
    for (let week = 0; week < 60; week++) {
      const rangeStart = new Date(dayTimeToUtc("2026-08-31", "00:00").getTime() + week * 7 * 86_400_000);
      const rangeEnd = new Date(rangeStart.getTime() + 7 * 86_400_000);

      const theirs = fingerprint(occurrencesInRange(cache, cancelled, rangeStart, rangeEnd));
      const mine = expandOccurrences(lessons, exceptions, rangeStart, rangeEnd, { coach: null })
        .map(o => `${o.lessonId}@${o.start}`)
        .sort();

      expect(mine, `week ${week} from ${rangeStart.toISOString()}`).toEqual(theirs);
      compared++;
      occurrences += mine.length;
    }
    console.log(`  compared ${compared} weeks, ${occurrences} occurrences — identical`);
  });

  it("agrees across the October daylight-saving change specifically", () => {
    const cache = buildLessonCache(lessons);
    const cancelled = buildCancelledSet(exceptions);
    const rangeStart = dayTimeToUtc("2026-10-12", "00:00");
    const rangeEnd = dayTimeToUtc("2026-11-16", "00:00");

    const theirs = fingerprint(occurrencesInRange(cache, cancelled, rangeStart, rangeEnd));
    const mine = expandOccurrences(lessons, exceptions, rangeStart, rangeEnd, { coach: null })
      .map(o => `${o.lessonId}@${o.start}`)
      .sort();
    expect(mine).toEqual(theirs);
  });
});
