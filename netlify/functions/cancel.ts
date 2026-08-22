/* =====================================================================
   POST /api/cancel   { lessonId, reason? }

   Cancelled bookings move to `booking_log` rather than being deleted.
   Statistics need the history — a hard delete makes reliability figures
   silently meaningless — but leaving a ghost in `lessons` would clutter
   the calendar and corrupt the lesson counts.

   Past the cancel cutoff this becomes a request instead of a dead end.
   The coach can always override.
   ===================================================================== */

import type { Config } from "@netlify/functions";
import type { DayIndexDoc, LessonDoc } from "../../src/shared/types.js";
import { callerFrom, clientFor } from "./_lib/auth.js";
import { ApiError, handler, json, readJson, requirePost } from "./_lib/http.js";
import { db } from "./_lib/admin.js";
import { notify, rebuildDays } from "./_lib/store.js";
import { dayKeysBetween, indexRange } from "../../src/shared/dayIndex.js";
import { canCancel } from "../../src/shared/slotEngine.js";
import { dayKey } from "../../src/shared/time.js";

interface CancelBody {
  lessonId?: string;
  reason?: string;
  /** Which occurrence of a weekly series. Ignored for one-offs. */
  occStart?: string;
  /** "one" carves a hole in the series; "series" ends it. */
  scope?: "one" | "series";
}

export default handler(async (req: Request) => {
  requirePost(req);

  const body = await readJson<CancelBody>(req);
  const lessonId = body.lessonId ?? "";
  if (!lessonId) throw new ApiError(400, "Which lesson?");

  const now = new Date();
  const caller = await callerFrom(req);
  const client = await clientFor(caller);

  const lessonRef = db().collection("lessons").doc(lessonId);
  const snap = await lessonRef.get();
  if (!snap.exists) throw new ApiError(404, "That lesson no longer exists.");

  const lesson = { ...(snap.data() as Omit<LessonDoc, "id">), id: snap.id };
  if (lesson.clientId !== client.id) throw new ApiError(403, "That is not your lesson.");
  if (lesson.source !== "booking") {
    throw new ApiError(403, "Your coach entered that lesson. Ask them to change it.");
  }

  // For a weekly series the client is cancelling one occurrence, not the
  // document's own start date.
  const occStart = lesson.repeatWeekly && body.occStart ? body.occStart : lesson.start;
  const start = new Date(occStart);
  if (Number.isNaN(start.getTime())) throw new ApiError(400, "That is not a valid time.");

  const allowed = canCancel(start, lesson.graceUntil, now);
  if (!allowed.allowed) {
    // Not a dead end: notify the coach, who can always override.
    const requestRef = db().collection("requests").doc();
    const batch = db().batch();
    batch.set(requestRef, {
      kind: "cancel",
      clientId: client.id,
      lessonId,
      start: occStart,
      message: body.reason ?? null,
      createdAt: now.toISOString(),
      status: "open",
      resolvedAt: null
    });
    notify(batch, {
      kind: "cancellation-requested",
      clientId: client.id,
      lessonId,
      start: occStart,
      requestId: requestRef.id
    }, now);
    await batch.commit();

    return json({ ok: false, requested: true, requestId: requestRef.id }, 202);
  }

  /* ---- a weekly series ---- */

  if (lesson.repeatWeekly) {
    const scope = body.scope === "series" ? "series" : "one";
    const result = scope === "series"
      ? await endSeries(lesson, occStart, client.id, body, now)
      : await cancelOneOccurrence(lesson, occStart, client.id, body, now);
    return json({ ok: true, scope, ...result });
  }

  /* ---- a single lesson ---- */

  const date = dayKey(start);
  const indexRef = db().collection("day_index").doc(date);
  const logRef = db().collection("booking_log").doc();

  await db().runTransaction(async tx => {
    const indexSnap = await tx.get(indexRef);

    tx.set(logRef, logEntry(lesson, lessonId, client.id, body, now, allowed.viaGrace));
    tx.delete(lessonRef);

    if (indexSnap.exists) {
      const index = indexSnap.data() as DayIndexDoc;
      tx.update(indexRef, {
        lessons: (index.lessons ?? []).filter(l => l.lessonId !== lessonId)
      });
    }
  });

  const batch = db().batch();
  notify(batch, {
    kind: "booking-cancelled",
    clientId: client.id,
    lessonId,
    start: lesson.start,
    viaGrace: allowed.viaGrace
  }, now);
  await batch.commit();

  return json({ ok: true, cancelled: lessonId, viaGrace: allowed.viaGrace });
});

/* =====================================================================
   Weekly series
   ===================================================================== */

/**
 * One week off, the rest of the series intact.
 *
 * Written as a `repeat_exceptions` document, which is exactly how the
 * calendar app cancels a single occurrence — so the coach's calendar
 * shows the hole without knowing anything about bookings.
 */
async function cancelOneOccurrence(
  lesson: LessonDoc, occStart: string, clientId: string, body: CancelBody, now: Date
) {
  const date = dayKey(new Date(occStart));
  const indexRef = db().collection("day_index").doc(date);

  await db().runTransaction(async tx => {
    const indexSnap = await tx.get(indexRef);

    tx.set(db().collection("repeat_exceptions").doc(), {
      parentId: lesson.id,
      occStart,
      type: "cancel"
    });
    tx.set(db().collection("booking_log").doc(),
      logEntry({ ...lesson, start: occStart }, lesson.id, clientId, body, now, false));

    if (indexSnap.exists) {
      const index = indexSnap.data() as DayIndexDoc;
      tx.update(indexRef, {
        lessons: (index.lessons ?? []).filter(
          l => !(l.lessonId === lesson.id && l.start === occStart)
        )
      });
    }
  });

  const batch = db().batch();
  notify(batch, {
    kind: "booking-cancelled",
    clientId,
    lessonId: lesson.id,
    start: occStart,
    scope: "one"
  }, now);
  await batch.commit();

  return { cancelled: occStart, date };
}

/**
 * Stop the series from this occurrence on.
 *
 * `repeatEndDate` is moved back rather than the document being deleted,
 * so weeks already taught keep their history — the statistics count them
 * and the coach's calendar still shows them. Occurrences before this one
 * are untouched, including any that are already inside their own
 * cancellation cutoff.
 */
async function endSeries(
  lesson: LessonDoc, occStart: string, clientId: string, body: CancelBody, now: Date
) {
  const from = new Date(occStart);
  // A minute before, so the occurrence being cancelled is itself excluded.
  const endDate = new Date(from.getTime() - 60_000).toISOString();

  await db().collection("lessons").doc(lesson.id).update({ repeatEndDate: endDate });

  const batch = db().batch();
  batch.set(db().collection("booking_log").doc(), {
    ...logEntry({ ...lesson, start: occStart }, lesson.id, clientId, body, now, false),
    scope: "series"
  });
  notify(batch, {
    kind: "booking-cancelled",
    clientId,
    lessonId: lesson.id,
    start: occStart,
    scope: "series"
  }, now);
  await batch.commit();

  // Every later week has to come out of the index, and only a rebuild
  // knows which days those were.
  const { to } = indexRange(now);
  const result = await rebuildDays(dayKeysBetween(dayKey(from), to), now);

  return { endedFrom: occStart, daysRebuilt: result.days };
}

function logEntry(
  lesson: LessonDoc | Omit<LessonDoc, "id">,
  lessonId: string,
  clientId: string,
  body: CancelBody,
  now: Date,
  viaGrace: boolean
) {
  return {
    clientId,
    lessonId,
    start: lesson.start,
    end: lesson.end,
    lessonType: lesson.lessonType ?? "class",
    title: lesson.title ?? null,
    bookedAt: lesson.bookedAt ?? null,
    cancelledAt: now.toISOString(),
    cancelledBy: "client" as const,
    reason: body.reason ?? null,
    viaGrace
  };
}

export const config: Config = { path: "/api/cancel" };
