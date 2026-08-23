/* =====================================================================
   The Firestore layer: reads, the index rebuild, and the notification
   queue.
   ===================================================================== */

import type {
  AvailabilityDoc, DayIndexDoc, ExceptionDoc, LessonDoc, Occurrence
} from "../../../src/shared/types.js";
import { COACH, COACH_CHANGE_GRACE_HOURS } from "../../../src/shared/config.js";
import { buildDayIndex, dayKeysBetween, indexRange } from "../../../src/shared/dayIndex.js";
import { dayKey } from "../../../src/shared/time.js";
import { windowForDay } from "../../../src/shared/availability.js";
import { FieldPath } from "firebase-admin/firestore";
import { db } from "./admin.js";
import { ApiError } from "./http.js";

/** Firestore rejects a batch over 500 writes. */
const BATCH_LIMIT = 400;

/* ---------- reads ---------- */

export async function loadLessons(): Promise<LessonDoc[]> {
  // `coach` is an array of display names, so array-contains is the right
  // filter — and the coach name lives in one constant, so adding a second
  // coach is a config change rather than a search-and-replace.
  const snap = await db().collection("lessons").where("coach", "array-contains", COACH).get();
  return snap.docs.map(d => ({ ...(d.data() as Omit<LessonDoc, "id">), id: d.id }));
}

export async function loadExceptions(): Promise<ExceptionDoc[]> {
  const snap = await db().collection("repeat_exceptions").get();
  return snap.docs.map(d => ({ ...(d.data() as ExceptionDoc), id: d.id }));
}

/* Every request that offers a slot reads the whole availability
   collection, and a Firestore round trip costs about the same whether it
   returns four documents or four hundred. Windows change a few times a
   month, so a warm function holding them for a few seconds removes a
   round trip from nearly every request.

   The booking path passes `fresh` and bypasses this: a stale window
   there could accept a lesson outside the coach's hours, and being
   right matters more than being quick at the moment of writing. */
const AVAILABILITY_TTL_MS = 20_000;
let availabilityCache: { at: number; docs: AvailabilityDoc[] } | null = null;

export async function loadAvailability(options: { fresh?: boolean } = {}): Promise<AvailabilityDoc[]> {
  if (!options.fresh && availabilityCache && Date.now() - availabilityCache.at < AVAILABILITY_TTL_MS) {
    return availabilityCache.docs;
  }
  const snap = await db().collection("availability").get();
  const docs = snap.docs.map(d => ({ ...(d.data() as AvailabilityDoc), id: d.id }));
  availabilityCache = { at: Date.now(), docs };
  return docs;
}

/** Called after any change so this instance does not serve what it just
 *  replaced. Other warm instances age out within the TTL. */
export function forgetAvailability(): void {
  availabilityCache = null;
}

export async function loadDayIndex(date: string): Promise<DayIndexDoc | null> {
  const doc = await db().collection("day_index").doc(date).get();
  return doc.exists ? (doc.data() as DayIndexDoc) : null;
}

/** Every index document from `from` to `to` inclusive. Day keys sort
 *  lexicographically, so a document-id range query is exact — and it is
 *  one query rather than four hundred point reads. */
export async function loadDayIndexRange(from: string, to: string): Promise<DayIndexDoc[]> {
  const snap = await db()
    .collection("day_index")
    .orderBy(FieldPath.documentId())
    .startAt(from)
    .endAt(to)
    .get();
  return snap.docs.map(d => d.data() as DayIndexDoc);
}

export async function loadDayIndexes(dates: string[]): Promise<Map<string, DayIndexDoc>> {
  const out = new Map<string, DayIndexDoc>();
  if (dates.length === 0) return out;
  const refs = dates.map(d => db().collection("day_index").doc(d));
  const docs = await db().getAll(...refs);
  for (const doc of docs) {
    if (doc.exists) out.set(doc.id, doc.data() as DayIndexDoc);
  }
  return out;
}

/** The window in force on a day, or null when the coach is not teaching. */
export async function windowFor(date: string): Promise<ReturnType<typeof windowForDay>> {
  return windowForDay(await loadAvailability(), date);
}

/* ---------- rebuild ---------- */

export interface MovedBooking {
  lessonId: string;
  clientId: string | null;
  from: string | null;
  to: string | null;
}

export interface RebuildResult {
  days: number;
  lessons: number;
  moved: MovedBooking[];
}

/**
 * Recompute the flattened index for a run of days.
 *
 * Also the only place that notices the coach moving a booked lesson in
 * the old calendar app, which knows nothing about bookings. Comparing
 * the previous index against the new one catches it regardless of which
 * app made the change — a client arriving at the wrong time is the worst
 * failure this system could produce.
 */
export async function rebuildDays(dayKeys: string[], now = new Date()): Promise<RebuildResult> {
  if (dayKeys.length === 0) return { days: 0, lessons: 0, moved: [] };

  const [lessons, exceptions, previous] = await Promise.all([
    loadLessons(),
    loadExceptions(),
    loadDayIndexes(dayKeys)
  ]);

  const rebuilt = buildDayIndex(lessons, exceptions, dayKeys, { now });

  const moved = detectMovedBookings(previous, rebuilt, dayKeys);

  let written = 0;
  let total = 0;
  for (let i = 0; i < rebuilt.length; i += BATCH_LIMIT) {
    const batch = db().batch();
    for (const day of rebuilt.slice(i, i + BATCH_LIMIT)) {
      batch.set(db().collection("day_index").doc(day.date), day);
      total += day.lessons.length;
      written++;
    }
    await batch.commit();
  }

  if (moved.length > 0) await handleMovedBookings(moved, now);

  return { days: written, lessons: total, moved };
}

/**
 * Delete dated windows whose day has passed.
 *
 * A dated entry only ever matches its own date, so once that date is
 * behind us the document can never apply again — but every request that
 * offers a slot reads the whole collection, so a season of one-off
 * overrides would quietly tax every booking. Weekly patterns are left
 * alone; they are meant to persist.
 */
export async function pruneAvailability(now = new Date()): Promise<number> {
  const cutoff = dayKey(now);
  const snap = await db().collection("availability").where("date", "<", cutoff).get();
  if (snap.empty) return 0;

  const batch = db().batch();
  for (const doc of snap.docs) batch.delete(doc.ref);
  await batch.commit();
  forgetAvailability();
  return snap.size;
}

/** Rebuild everything the index covers. The nightly safety net. */
export async function rebuildAll(now = new Date()): Promise<RebuildResult> {
  const { from, to } = indexRange(now);
  return rebuildDays(dayKeysBetween(from, to), now);
}

function detectMovedBookings(
  previous: Map<string, DayIndexDoc>,
  rebuilt: DayIndexDoc[],
  dayKeys: string[]
): MovedBooking[] {
  const before = new Map<string, Occurrence>();
  for (const date of dayKeys) {
    for (const occ of previous.get(date)?.lessons ?? []) {
      if (occ.source === "booking") before.set(occ.lessonId, occ);
    }
  }

  const after = new Map<string, Occurrence>();
  for (const day of rebuilt) {
    for (const occ of day.lessons) {
      if (occ.source === "booking") after.set(occ.lessonId, occ);
    }
  }

  const moved: MovedBooking[] = [];
  for (const [lessonId, was] of before) {
    const is = after.get(lessonId);
    // Gone entirely is not necessarily a move: /api/cancel logs its own
    // removal, and a rebuild of a narrower range would see a false
    // disappearance. Only a lesson that still exists at a different time
    // is reported here.
    if (is && is.start !== was.start) {
      moved.push({ lessonId, clientId: is.clientId ?? was.clientId ?? null, from: was.start, to: is.start });
    }
  }
  return moved;
}

/**
 * A coach-initiated change grants a fresh cancellation right. Moving
 * someone at 30 hours out would otherwise put them past their own cancel
 * cutoff, stuck with a time they never chose — and the compact-day
 * button does exactly this by design.
 *
 * Thirty minutes is too short here: the client did not initiate the
 * change and may be asleep. Twelve hours, capped at the lesson start.
 */
async function handleMovedBookings(moved: MovedBooking[], now: Date): Promise<void> {
  const batch = db().batch();
  for (const move of moved) {
    if (!move.to) continue;
    const start = new Date(move.to).getTime();
    const grace = Math.min(now.getTime() + COACH_CHANGE_GRACE_HOURS * 3_600_000, start);
    batch.update(db().collection("lessons").doc(move.lessonId), {
      graceUntil: new Date(grace).toISOString()
    });
    batch.set(db().collection("notifications").doc(), {
      kind: "lesson-moved",
      clientId: move.clientId,
      lessonId: move.lessonId,
      from: move.from,
      to: move.to,
      createdAt: now.toISOString(),
      deliveredAt: null
    });
  }
  await batch.commit();
}

/** Queue a message for a client. Nothing sends it: the coach drains the
 *  queue by hand from the "To tell" tab, through whichever app that
 *  client actually reads. Recording it durably is what stops a lesson
 *  moving without anyone saying so. */
export function notify(
  batch: FirebaseFirestore.WriteBatch,
  payload: Record<string, unknown>,
  now: Date
): void {
  batch.set(db().collection("notifications").doc(), {
    ...payload, createdAt: now.toISOString(), deliveredAt: null
  });
}

/* ---------- guards ---------- */

export function assertIndexedDate(date: string, now = new Date()): void {
  const { from, to } = indexRange(now);
  if (date < from || date > to) {
    throw new ApiError(400, "That date is outside the booking calendar.");
  }
}
