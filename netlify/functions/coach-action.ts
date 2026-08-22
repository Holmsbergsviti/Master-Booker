/* =====================================================================
   POST /api/coach/action   { action, ... }

   The coach's write surface. Bookings are auto-confirmed and there is no
   approval queue, but the coach can move, reassign or cancel anything —
   and those edits bypass the rules rather than being blocked by them.
   Four lessons in a row with no break is allowed: the system warns and
   gets out of the way. The validator constrains clients, not the coach.

   Two things that requires, and both are handled here:

     - Notify the client on any coach-side change. A lesson silently
       moving an hour is the worst failure this system could produce.
     - Grant a fresh cancellation right. Moving someone at 30 hours out
       would otherwise leave them past their own cancel cutoff, stuck
       with a time they never chose.
   ===================================================================== */

import type { Config } from "@netlify/functions";
import type { AvailabilityDoc, ClientDoc, LessonDoc, RequestDoc } from "../../src/shared/types.js";
import { requireCoach } from "./_lib/auth.js";
import { ApiError, handler, json, readJson, requirePost } from "./_lib/http.js";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "./_lib/admin.js";
import { loadAvailability, loadDayIndex, notify, rebuildDays } from "./_lib/store.js";
import { windowForDay } from "../../src/shared/availability.js";
import { affectedDayKeys } from "../../src/shared/dayIndex.js";
import { compactDay, type Move } from "../../src/shared/compact.js";
import { deadTime, toIntervals } from "../../src/shared/slotEngine.js";
import { COACH_CHANGE_GRACE_HOURS, LESSONS_PER_BREAK, lessonSpec } from "../../src/shared/config.js";
import { dayKey, lessonMinutes } from "../../src/shared/time.js";
import { isChannel, normalisePhone } from "../../src/shared/contact.js";

interface Body {
  action?: string;
  [key: string]: unknown;
}

export default handler(async (req: Request) => {
  requirePost(req);
  await requireCoach(req);

  const body = await readJson<Body>(req);
  const now = new Date();

  switch (body.action) {
    case "move":            return moveLesson(body, now);
    case "cancel":          return cancelLesson(body, now);
    case "reassign":        return reassign(body, now);
    case "compact-day":     return compact(body, now);
    case "resolve-request": return resolveRequest(body, now);
    case "save-availability": return saveAvailability(body, now);
    case "delete-availability": return deleteAvailability(body, now);
    case "save-client":     return saveClient(body);
    case "map-title":       return mapTitle(body, now);
    case "mark-notified":   return markNotified(body, now);
    default:
      throw new ApiError(400, `Unknown action: ${String(body.action ?? "")}`);
  }
});

/* ---------- lessons ---------- */

/** The grace a coach-side change grants: twelve hours, capped at the
 *  lesson itself. Thirty minutes is too short — the client did not
 *  initiate the change and may be asleep. */
function coachGrace(startIso: string, now: Date): string {
  const start = new Date(startIso).getTime();
  return new Date(Math.min(now.getTime() + COACH_CHANGE_GRACE_HOURS * 3_600_000, start)).toISOString();
}

async function moveLesson(body: Body, now: Date): Promise<Response> {
  const lessonId = String(body.lessonId ?? "");
  const startIso = String(body.start ?? "");
  const start = new Date(startIso);
  if (!lessonId || Number.isNaN(start.getTime())) throw new ApiError(400, "Pass a lesson and a new start.");

  const ref = db().collection("lessons").doc(lessonId);
  const snap = await ref.get();
  if (!snap.exists) throw new ApiError(404, "That lesson no longer exists.");
  const lesson = snap.data() as LessonDoc;

  const minutes = lessonMinutes(lesson.start, lesson.end) || lessonSpec(lesson.lessonType).mins;
  const end = new Date(start.getTime() + minutes * 60_000);

  const update: Record<string, unknown> = {
    start: start.toISOString(),
    end: end.toISOString(),
    occStart: start.toISOString()
  };
  // Only a booked lesson has a client to owe a cancellation right to.
  if (lesson.source === "booking") update.graceUntil = coachGrace(start.toISOString(), now);

  await ref.update(update);

  const days = [...new Set([dayKey(new Date(lesson.start)), dayKey(start)])];
  await rebuildDays(days, now);

  if (lesson.source === "booking" && lesson.clientId) {
    const batch = db().batch();
    notify(batch, {
      kind: "lesson-moved",
      clientId: lesson.clientId,
      lessonId,
      from: lesson.start,
      to: start.toISOString(),
      by: "coach"
    }, now);
    await batch.commit();
  }

  return json({ ok: true, warnings: await warningsFor(dayKey(start), now) });
}

async function cancelLesson(body: Body, now: Date): Promise<Response> {
  const lessonId = String(body.lessonId ?? "");
  if (!lessonId) throw new ApiError(400, "Which lesson?");

  const ref = db().collection("lessons").doc(lessonId);
  const snap = await ref.get();
  if (!snap.exists) throw new ApiError(404, "That lesson no longer exists.");
  const lesson = snap.data() as LessonDoc;

  const batch = db().batch();
  // Never hard-delete a booking: reliability statistics would go
  // silently meaningless.
  if (lesson.source === "booking" && lesson.clientId) {
    batch.set(db().collection("booking_log").doc(), {
      clientId: lesson.clientId,
      lessonId,
      start: lesson.start,
      end: lesson.end,
      lessonType: lesson.lessonType ?? "class",
      title: lesson.title ?? null,
      bookedAt: lesson.bookedAt ?? null,
      cancelledAt: now.toISOString(),
      cancelledBy: "coach",
      reason: (body.reason as string) ?? null
    });
    notify(batch, {
      kind: "lesson-cancelled-by-coach",
      clientId: lesson.clientId,
      lessonId,
      start: lesson.start
    }, now);
  }
  batch.delete(ref);
  await batch.commit();

  await rebuildDays(affectedDayKeys(lesson, now), now);
  return json({ ok: true });
}

async function reassign(body: Body, now: Date): Promise<Response> {
  const lessonId = String(body.lessonId ?? "");
  const clientId = String(body.clientId ?? "");
  if (!lessonId || !clientId) throw new ApiError(400, "Pass a lesson and a client.");

  const client = await db().collection("clients").doc(clientId).get();
  if (!client.exists) throw new ApiError(404, "No such client.");
  const name = (client.data() as ClientDoc).displayName;

  const ref = db().collection("lessons").doc(lessonId);
  const snap = await ref.get();
  if (!snap.exists) throw new ApiError(404, "That lesson no longer exists.");
  const lesson = snap.data() as LessonDoc;

  await ref.update({ clientId, title: name });
  await rebuildDays(affectedDayKeys(lesson, now), now);
  return json({ ok: true });
}

/* ---------- compact day ---------- */

async function compact(body: Body, now: Date): Promise<Response> {
  const date = String(body.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, "Pass a date.");

  const [availability, index] = await Promise.all([loadAvailability(), loadDayIndex(date)]);
  const window = windowForDay(availability, date);
  if (!window) throw new ApiError(409, "There is no availability that day.");

  const plan = compactDay({ date, windowStart: window.start, lessons: index?.lessons ?? [] });

  // Applying notifies every client it touches, so the coach confirms
  // against the preview rather than the button doing it outright.
  if (!body.apply) return json({ ok: true, applied: false, ...plan });

  if (plan.moves.length === 0) return json({ ok: true, applied: true, ...plan });

  const batch = db().batch();
  for (const move of plan.moves) {
    applyMove(batch, move, now);
  }
  await batch.commit();

  await rebuildDays([date], now);
  return json({ ok: true, applied: true, ...plan });
}

function applyMove(batch: FirebaseFirestore.WriteBatch, move: Move, now: Date): void {
  const ref = db().collection("lessons").doc(move.lessonId);
  const end = new Date(new Date(move.to).getTime() + move.durationMins * 60_000);

  batch.update(ref, {
    start: move.to,
    end: end.toISOString(),
    occStart: move.to,
    // Ticking the flexible box consents to the shift, not to losing the
    // right to change your mind about it.
    graceUntil: new Date(Math.min(
      now.getTime() + COACH_CHANGE_GRACE_HOURS * 3_600_000,
      new Date(move.to).getTime()
    )).toISOString()
  });
  notify(batch, {
    kind: "lesson-moved",
    clientId: move.clientId,
    lessonId: move.lessonId,
    from: move.from,
    to: move.to,
    by: "compact-day"
  }, now);
}

/* ---------- requests ---------- */

async function resolveRequest(body: Body, now: Date): Promise<Response> {
  const requestId = String(body.requestId ?? "");
  const approve = !!body.approve;
  if (!requestId) throw new ApiError(400, "Which request?");

  const ref = db().collection("requests").doc(requestId);
  const snap = await ref.get();
  if (!snap.exists) throw new ApiError(404, "No such request.");
  const request = snap.data() as RequestDoc;

  await ref.update({
    status: approve ? "approved" : "declined",
    resolvedAt: now.toISOString()
  });

  if (approve && request.kind === "cancel" && request.lessonId) {
    await cancelLesson({ lessonId: request.lessonId, reason: "Late cancellation approved" }, now);
  } else {
    const batch = db().batch();
    notify(batch, {
      kind: approve ? "request-approved" : "request-declined",
      clientId: request.clientId,
      lessonId: request.lessonId ?? null,
      requestId
    }, now);
    await batch.commit();
  }

  return json({ ok: true });
}

/* ---------- availability ---------- */

async function saveAvailability(body: Body, now: Date): Promise<Response> {
  const doc = body.doc as AvailabilityDoc | undefined;
  if (!doc?.start || !doc?.end) throw new ApiError(400, "Pass a window with a start and an end.");
  if (!doc.date && (doc.weekday === undefined || doc.weekday === null)) {
    throw new ApiError(400, "A window needs either a date or a weekday.");
  }

  const payload: AvailabilityDoc = {
    date: doc.date ?? null,
    weekday: doc.weekday ?? null,
    validFrom: doc.validFrom ?? null,
    validUntil: doc.validUntil ?? null,
    start: doc.start,
    end: doc.end,
    gapBudget: doc.gapBudget ?? null,
    closed: !!doc.closed
  };

  const id = typeof body.id === "string" && body.id ? body.id : undefined;
  const ref = id ? db().collection("availability").doc(id) : db().collection("availability").doc();
  await ref.set(payload);

  // Availability does not live in the index, but the pages that read it
  // alongside the index should not show one refreshed and the other not.
  if (payload.date) await rebuildDays([payload.date], now);
  return json({ ok: true, id: ref.id });
}

async function deleteAvailability(body: Body, _now: Date): Promise<Response> {
  const id = String(body.id ?? "");
  if (!id) throw new ApiError(400, "Which window?");
  await db().collection("availability").doc(id).delete();
  return json({ ok: true });
}

/* ---------- clients ---------- */

async function saveClient(body: Body): Promise<Response> {
  const input = body.client as Partial<ClientDoc> | undefined;
  if (!input?.displayName) throw new ApiError(400, "A client needs a display name.");

  const people = (input.people ?? [])
    .filter(p => p && typeof p.name === "string" && p.name.trim())
    .map(p => ({ name: p.name.trim() }));
  if (people.length === 0 || people.length > 2) {
    throw new ApiError(400, "A client is one or two people.");
  }

  const payload: Record<string, unknown> = {
    displayName: input.displayName.trim(),
    people,
    defaultLessonType: input.defaultLessonType ?? "class",
    active: input.active !== false,
    phone: input.phone ? normalisePhone(input.phone) : null,
    channels: (input.channels ?? []).filter(isChannel)
  };

  // Deliberately not written here. `map-title` adds to it with
  // arrayUnion, and a save that happened to omit the field would wipe
  // every mapping the backfill had recovered. `token` is absent for the
  // same reason: overwriting it would sign the client out everywhere.
  if (input.titleAliases) payload.titleAliases = input.titleAliases;

  const id = typeof body.id === "string" && body.id ? body.id : undefined;
  const ref = id ? db().collection("clients").doc(id) : db().collection("clients").doc();
  await ref.set(payload, { merge: true });
  return json({ ok: true, id: ref.id });
}

/**
 * Backfill: lessons entered by hand between the season start and launch
 * carry no clientId, but their titles are already clean names. Tapping a
 * title to a client stamps every matching lesson at once.
 */
async function mapTitle(body: Body, now: Date): Promise<Response> {
  const title = String(body.title ?? "").trim();
  const clientId = String(body.clientId ?? "");
  if (!title || !clientId) throw new ApiError(400, "Pass a title and a client.");

  const client = await db().collection("clients").doc(clientId).get();
  if (!client.exists) throw new ApiError(404, "No such client.");

  const snap = await db().collection("lessons").where("title", "==", title).get();
  const touched: string[] = [];
  let batch = db().batch();
  let queued = 0;

  for (const doc of snap.docs) {
    const lesson = doc.data() as LessonDoc;
    if (lesson.clientId) continue; // never re-stamp an already-mapped lesson
    batch.update(doc.ref, { clientId });
    touched.push(...affectedDayKeys(lesson, now));
    if (++queued >= 400) { await batch.commit(); batch = db().batch(); queued = 0; }
  }
  if (queued > 0) await batch.commit();

  batch = db().batch();
  batch.update(db().collection("clients").doc(clientId), {
    titleAliases: FieldValue.arrayUnion(title)
  });
  await batch.commit();

  const days = [...new Set(touched)];
  if (days.length > 0) await rebuildDays(days, now);

  return json({ ok: true, lessons: snap.size, days: days.length });
}

/* ---------- outbox ---------- */

/** Nothing sends these; the coach does, by hand, through whichever app
 *  the client actually reads. This records that it happened so the same
 *  message is not sent twice — or, worse, assumed sent and never made. */
async function markNotified(body: Body, now: Date): Promise<Response> {
  const ids = Array.isArray(body.ids) ? body.ids.filter((i): i is string => typeof i === "string")
    : typeof body.id === "string" ? [body.id] : [];
  if (ids.length === 0) throw new ApiError(400, "Which message?");

  const batch = db().batch();
  for (const id of ids) {
    batch.update(db().collection("notifications").doc(id), {
      deliveredAt: now.toISOString(),
      deliveredVia: typeof body.via === "string" ? body.via : null
    });
  }
  await batch.commit();
  return json({ ok: true, marked: ids.length });
}

/* ---------- warnings ---------- */

/** The system warns and gets out of the way: never a refusal, just a
 *  note that the day now asks a lot of the coach. */
async function warningsFor(date: string, _now: Date): Promise<string[]> {
  const index = await loadDayIndex(date);
  const lessons = index?.lessons ?? [];
  if (lessons.length === 0) return [];

  const out: string[] = [];
  const intervals = toIntervals(lessons, date);
  const metric = deadTime(intervals);
  if (metric.dead >= 60) out.push(`${metric.dead} minutes of idle time on this day.`);

  let run = 0;
  let longest = 0;
  for (let i = 0; i < intervals.length; i++) {
    run += intervals[i]!.weight;
    longest = Math.max(longest, run);
    const next = intervals[i + 1];
    if (!next || next.startMin - intervals[i]!.endMin >= 15) run = 0;
  }
  if (longest > LESSONS_PER_BREAK) {
    out.push(`${longest} lessons back to back with no break.`);
  }
  return out;
}

export const config: Config = { path: "/api/coach/action" };
