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
import type { DayIndexDoc, LessonDoc } from "../../src/shared/types.js";
import { callerFrom, clientFor } from "./_lib/auth.js";
import { ApiError, handler, json, readJson, requirePost } from "./_lib/http.js";
import { db } from "./_lib/admin.js";
import { assertIndexedDate, loadAvailability, notify } from "./_lib/store.js";
import { windowForDay } from "../../src/shared/availability.js";
import { COACH, GRACE_MINUTES, lessonSpec } from "../../src/shared/config.js";
import { isFinalOnceGraceExpires, validateSlot } from "../../src/shared/slotEngine.js";
import { dayKey, formatTime } from "../../src/shared/time.js";

interface BookBody {
  date?: string;
  start?: string;
  lessonType?: string;
  flexible?: boolean;
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

  const window = windowForDay(await loadAvailability(), date);
  if (!window) throw new ApiError(409, "The coach is not teaching that day.");

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

    const lesson: Omit<LessonDoc, "id"> = {
      coach: [COACH],
      // Bookings must write a title in the same style as manual entries —
      // that is what shows on the coach's calendar.
      title: client.displayName,
      start: check.slot.start,
      end: check.slot.end,
      occStart: check.slot.start,
      lessonType,
      repeatWeekly: false,
      clientId: client.id,
      source: "booking",
      flexible: !!body.flexible,
      bookedAt: now.toISOString(),
      graceUntil: graceUntil.toISOString()
    };

    tx.set(lessonRef, lesson);

    // Keep the index consistent with the write inside the same
    // transaction. The scheduled rebuild would catch up eventually, but
    // "eventually" is long enough for the next student to double-book.
    tx.update(indexRef, {
      lessons: [...(index.lessons ?? []), {
        lessonId: lessonRef.id,
        start: check.slot.start,
        end: check.slot.end,
        occStart: check.slot.start,
        lessonType,
        coach: lesson.coach,
        title: client.displayName,
        clientId: client.id,
        source: "booking",
        flexible: !!body.flexible,
        graceUntil: graceUntil.toISOString(),
        repeatWeekly: false
      }].sort((a, b) => a.start.localeCompare(b.start))
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

export const config: Config = { path: "/api/book" };
