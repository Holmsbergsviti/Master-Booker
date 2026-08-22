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
import { notify } from "./_lib/store.js";
import { canCancel } from "../../src/shared/slotEngine.js";
import { dayKey } from "../../src/shared/time.js";

interface CancelBody {
  lessonId?: string;
  reason?: string;
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

  const start = new Date(lesson.start);
  const allowed = canCancel(start, lesson.graceUntil, now);
  if (!allowed.allowed) {
    // Not a dead end: notify the coach, who can always override.
    const requestRef = db().collection("requests").doc();
    const batch = db().batch();
    batch.set(requestRef, {
      kind: "cancel",
      clientId: client.id,
      lessonId,
      start: lesson.start,
      message: body.reason ?? null,
      createdAt: now.toISOString(),
      status: "open",
      resolvedAt: null
    });
    notify(batch, {
      kind: "cancellation-requested",
      clientId: client.id,
      lessonId,
      start: lesson.start,
      requestId: requestRef.id
    }, now);
    await batch.commit();

    return json({ ok: false, requested: true, requestId: requestRef.id }, 202);
  }

  const date = dayKey(start);
  const indexRef = db().collection("day_index").doc(date);
  const logRef = db().collection("booking_log").doc();

  await db().runTransaction(async tx => {
    const indexSnap = await tx.get(indexRef);

    tx.set(logRef, {
      clientId: client.id,
      lessonId,
      start: lesson.start,
      end: lesson.end,
      lessonType: lesson.lessonType ?? "class",
      title: lesson.title ?? null,
      bookedAt: lesson.bookedAt ?? null,
      cancelledAt: now.toISOString(),
      cancelledBy: "client",
      reason: body.reason ?? null,
      viaGrace: allowed.viaGrace
    });

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

export const config: Config = { path: "/api/cancel" };
