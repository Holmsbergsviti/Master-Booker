/* =====================================================================
   POST /api/book   { date, start, lessonType?, flexible? }

   The only way a lesson gets written. Firestore rules deny client writes
   to `lessons` outright, because rules cannot express "no more than
   three consecutive lessons" or "leaves at most 45 minutes idle" — they
   cannot read sibling documents. So validation lives here.

   The write is a transaction over the day index. Reading that one
   document is what makes it safe: if anything about the day changed
   between validation and commit, Firestore aborts and the caller retries
   against the new truth. Two students racing for the last slot cannot
   both win.
   ===================================================================== */

import type { Config } from "@netlify/functions";
import type { AvailabilityDoc, ClientDoc, DayIndexDoc, LessonDoc } from "../../src/shared/types.js";
import { callerFrom, clientFor } from "./_lib/auth.js";
import { ApiError, handler, json, readJson, requirePost } from "./_lib/http.js";
import { db } from "./_lib/admin.js";
import { assertIndexedDate, loadAvailability, notify } from "./_lib/store.js";
import { windowForDay } from "../../src/shared/availability.js";
import { COACH, GRACE_MINUTES, lessonSpec } from "../../src/shared/config.js";
import { isFinalOnceGraceExpires, validateSlot } from "../../src/shared/slotEngine.js";
import { addDaysWallClock, dayKey, formatTime } from "../../src/shared/time.js";
import { indexRange } from "../../src/shared/dayIndex.js";
import { planWeekly } from "../../src/shared/recurrence.js";

interface BookBody {
  date?: string;
  start?: string;
  lessonType?: string;
  flexible?: boolean;
  /** Same time every week, for as far ahead as the index reaches. */
  repeatWeekly?: boolean;
}

export default handler(async (req: Request) => {
  requirePost(req);

  const body = await readJson<BookBody>(req);
  const start = body.start ?? "";
  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) throw new ApiError(400, "Pass the slot start time.");

  const now = new Date();
  const date = body.date ?? dayKey(startDate);
  if (date !== dayKey(startDate)) throw new ApiError(400, "That time is not on that date.");
  assertIndexedDate(date, now);

  const caller = await callerFrom(req);
  const client = await clientFor(caller);

  const lessonType = body.lessonType ?? client.defaultLessonType;
  const spec = lessonSpec(lessonType);
  if (!spec.bookable) throw new ApiError(400, "That lesson type cannot be booked online.");

  const availability = await loadAvailability({ fresh: true });
  const window = windowForDay(availability, date);
  if (!window) throw new ApiError(409, "The coach is not teaching that day.");

  if (body.repeatWeekly) {
    return bookWeekly({ date, startDate, lessonType, client, availability, body, now });
  }

  const indexRef = db().collection("day_index").doc(date);
  const lessonRef = db().collection("lessons").doc();
  const graceUntil = new Date(now.getTime() + GRACE_MINUTES * 60_000);

  const result = await db().runTransaction(async tx => {
    const indexSnap = await tx.get(indexRef);
    if (!indexSnap.exists) {
      // A missing document is not an empty day. It means the index has
      // never been built for this date, and treating it as free would
      // sell a slot that may well be taken.
      throw new ApiError(503, "That day is not ready for booking yet. Please try again shortly.");
    }
    const index = indexSnap.data() as DayIndexDoc;

    // The same call the slot list made. Not a second implementation of
    // the same rules — literally the same function.
    const check = validateSlot(
      { date, window, existing: index.lessons ?? [], lessonType, now },
      startDate.toISOString()
    );
    if (!check.ok) throw new ApiError(409, check.message, check.reason);

    const lesson = lessonDoc({ client, check, lessonType, body, now, graceUntil });
    tx.set(lessonRef, lesson);

    // Keep the index consistent with the write inside the same
    // transaction. The scheduled rebuild would catch up eventually, but
    // "eventually" is long enough for the next student to double-book.
    tx.update(indexRef, {
      lessons: [...(index.lessons ?? []), occurrenceFor(lessonRef.id, lesson)]
        .sort((a, b) => a.start.localeCompare(b.start))
    });

    return check.slot;
  });

  const batch = db().batch();
  notify(batch, {
    kind: "booking-confirmed",
    clientId: client.id,
    lessonId: lessonRef.id,
    start: result.start
  }, now);
  await batch.commit();

  return json({
    ok: true,
    lessonId: lessonRef.id,
    start: result.start,
    end: result.end,
    label: formatTime(new Date(result.start)),
    graceUntil: graceUntil.toISOString(),
    // Anything booked inside 36h is final once its 30 minutes expire.
    // The client is told at confirmation, not left to discover it.
    finalAfterGrace: isFinalOnceGraceExpires(startDate, now)
  });
});

/* =====================================================================
   Weekly
   ===================================================================== */

interface WeeklyArgs {
  date: string;
  startDate: Date;
  lessonType: string;
  client: ClientDoc;
  availability: AvailabilityDoc[];
  body: BookBody;
  now: Date;
}

/**
 * The same time every week.
 *
 * Written as one repeating document, exactly as the calendar app writes
 * repeats, with `repeat_exceptions` carving out the weeks that were
 * already taken. That keeps recurrence knowledge in one place: the day
 * index expands the rule into later weeks by itself as the horizon rolls
 * forward, so a series booked today keeps producing lessons in December
 * without anything else running.
 *
 * Every affected day is read inside the transaction, so a series cannot
 * be sold a slot that someone took while this was being validated.
 */
async function bookWeekly(args: WeeklyArgs): Promise<Response> {
  const { date, startDate, lessonType, client, availability, body, now } = args;
  const horizon = indexRange(now).to;
  const startLabel = formatTime(startDate);

  const dates: string[] = [];
  for (let week = 0; ; week++) {
    const occurrence = addDaysWallClock(startDate, week * 7);
    const key = dayKey(occurrence);
    if (key > horizon) break;
    dates.push(key);
    if (dates.length > 60) break;
  }

  const indexRefs = dates.map(d => db().collection("day_index").doc(d));
  const lessonRef = db().collection("lessons").doc();
  const graceUntil = new Date(now.getTime() + GRACE_MINUTES * 60_000);

  const plan = await db().runTransaction(async tx => {
    const snaps = await tx.getAll(...indexRefs);
    const byDate = new Map<string, DayIndexDoc>();
    for (const snap of snaps) {
      if (snap.exists) byDate.set(snap.id, snap.data() as DayIndexDoc);
    }
    if (!byDate.has(date)) {
      throw new ApiError(503, "That day is not ready for booking yet. Please try again shortly.");
    }

    const planned = planWeekly({
      firstDate: date,
      startLabel,
      lessonType,
      now,
      horizon,
      windowFor: d => windowForDay(availability, d),
      // Null, not an empty array: a day with no index document has not
      // been worked out, and treating it as free would be a guess.
      existingFor: d => byDate.has(d) ? (byDate.get(d)!.lessons ?? []) : null
    });

    if (planned.bookable.length === 0) {
      const first = planned.occurrences[0];
      throw new ApiError(409, first?.message ?? "None of those weeks are free.", first?.reason);
    }
    // The week the student actually pressed on has to be one of them.
    if (!planned.bookable.some(o => o.date === date)) {
      const refused = planned.occurrences.find(o => o.date === date);
      throw new ApiError(409, refused?.message ?? "That time has just been taken.", refused?.reason);
    }

    const last = planned.bookable[planned.bookable.length - 1]!;
    const lesson: Omit<LessonDoc, "id"> = {
      coach: [COACH],
      title: client.displayName,
      start: planned.bookable[0]!.start,
      end: planned.bookable[0]!.end,
      occStart: planned.bookable[0]!.start,
      lessonType,
      repeatWeekly: true,
      // Bounded at the horizon it was validated to. The series stops
      // there rather than running into weeks nobody has checked.
      repeatEndDate: new Date(new Date(last.start).getTime() + 60_000).toISOString(),
      clientId: client.id,
      source: "booking",
      flexible: !!body.flexible,
      bookedAt: now.toISOString(),
      graceUntil: graceUntil.toISOString()
    };
    tx.set(lessonRef, lesson);

    // Weeks that were already taken become holes in the rule, which is
    // what repeat_exceptions is for.
    for (const blocked of planned.blocked) {
      if (blocked.date < planned.bookable[0]!.date || blocked.date > last.date) continue;
      tx.set(db().collection("repeat_exceptions").doc(), {
        parentId: lessonRef.id,
        occStart: blocked.start,
        type: "cancel"
      });
    }

    for (const occurrence of planned.bookable) {
      const existing = byDate.get(occurrence.date);
      if (!existing) continue;
      tx.update(db().collection("day_index").doc(occurrence.date), {
        lessons: [...(existing.lessons ?? []), occurrenceFor(lessonRef.id, {
          ...lesson,
          start: occurrence.start,
          end: occurrence.end,
          occStart: occurrence.start
        })].sort((a, b) => a.start.localeCompare(b.start))
      });
    }

    return planned;
  });

  const batch = db().batch();
  notify(batch, {
    kind: "booking-confirmed",
    clientId: client.id,
    lessonId: lessonRef.id,
    start: plan.bookable[0]!.start,
    repeatWeekly: true,
    weeks: plan.bookable.length
  }, now);
  await batch.commit();

  return json({
    ok: true,
    lessonId: lessonRef.id,
    repeatWeekly: true,
    start: plan.bookable[0]!.start,
    end: plan.bookable[0]!.end,
    label: startLabel,
    weeks: plan.bookable.length,
    // Named so the client can say which weeks it could not get rather
    // than quietly booking fewer than asked for.
    skipped: plan.blocked
      .filter(o => o.date >= plan.bookable[0]!.date)
      .map(o => ({ date: o.date, message: o.message ?? "Not available" })),
    graceUntil: graceUntil.toISOString(),
    finalAfterGrace: isFinalOnceGraceExpires(startDate, now)
  });
}

/* ---------- shared shapes ---------- */

function lessonDoc(args: {
  client: ClientDoc;
  check: { slot: { start: string; end: string } };
  lessonType: string;
  body: BookBody;
  now: Date;
  graceUntil: Date;
}): Omit<LessonDoc, "id"> {
  return {
    coach: [COACH],
    // Bookings must write a title in the same style as manual entries —
    // that is what shows on the coach's calendar.
    title: args.client.displayName,
    start: args.check.slot.start,
    end: args.check.slot.end,
    occStart: args.check.slot.start,
    lessonType: args.lessonType,
    repeatWeekly: false,
    clientId: args.client.id,
    source: "booking",
    flexible: !!args.body.flexible,
    bookedAt: args.now.toISOString(),
    graceUntil: args.graceUntil.toISOString()
  };
}

/** The flattened shape the day index stores. */
function occurrenceFor(lessonId: string, lesson: Omit<LessonDoc, "id">) {
  return {
    lessonId,
    start: lesson.start,
    end: lesson.end,
    occStart: lesson.occStart ?? lesson.start,
    lessonType: lesson.lessonType ?? "class",
    coach: lesson.coach,
    title: lesson.title ?? null,
    clientId: lesson.clientId ?? null,
    source: lesson.source ?? null,
    flexible: !!lesson.flexible,
    graceUntil: lesson.graceUntil ?? null,
    repeatWeekly: !!lesson.repeatWeekly
  };
}

export const config: Config = { path: "/api/book" };
