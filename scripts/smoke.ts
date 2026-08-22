/* =====================================================================
   End-to-end smoke test.

   Calls the real function handlers — the same code Netlify runs, with
   the same auth — against the real database, then removes everything it
   made. This is the one thing unit tests cannot cover: that sign-in,
   the booking transaction, the index write and the cancellation actually
   work against Firestore rather than merely typechecking.

       npm run smoke

   It creates a test client, an availability window on a date far enough
   out to clear the 24-hour cutoff, and one booking. Every document it
   writes is deleted at the end, including on failure.
   ===================================================================== */

import signin from "../netlify/functions/signin.js";
import slots from "../netlify/functions/slots.js";
import book from "../netlify/functions/book.js";
import cancel from "../netlify/functions/cancel.js";
import coachAction from "../netlify/functions/coach-action.js";
import coachOutbox from "../netlify/functions/coach-outbox.js";
import { db } from "../netlify/functions/_lib/admin.js";
import { rebuildDays } from "../netlify/functions/_lib/store.js";
import { addDayKey, dayKey } from "../src/shared/time.js";

process.env.COACH_PASSCODE ??= "smoke-test-passcode";
const COACH = `Bearer coach:${process.env.COACH_PASSCODE}`;
const BASE = "https://smoke.test";

// Far enough out to be past the 24h cutoff and inside the index range.
const DATE = addDayKey(dayKey(new Date()), 30);
const PHONE = "064 000 0001";

const made: Array<() => Promise<unknown>> = [];
let failures = 0;

function step(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function json(response: Response): Promise<any> {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

const post = (fn: (r: Request) => Promise<Response>, path: string, body: unknown, auth?: string) =>
  fn(new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body)
  }));

const get = (fn: (r: Request) => Promise<Response>, path: string, auth: string) =>
  fn(new Request(`${BASE}${path}`, { headers: { authorization: auth } }));

async function main(): Promise<void> {
  console.log(`\nSmoke test against ${DATE}\n`);

  /* --- availability --- */
  const availability = await post(coachAction, "/api/coach/action", {
    action: "save-availability",
    doc: { date: DATE, start: "16:00", end: "21:00" }
  }, COACH);
  const availabilityBody = await json(availability);
  step("coach creates an availability window", availability.status === 200, availabilityBody.error);
  if (availabilityBody.id) {
    made.push(() => db().collection("availability").doc(availabilityBody.id).delete());
  }

  const wrongPasscode = await post(coachAction, "/api/coach/action",
    { action: "save-availability", doc: { date: DATE, start: "16:00", end: "21:00" } },
    "Bearer coach:not-the-passcode");
  step("coach endpoint refuses a wrong passcode", wrongPasscode.status === 403);

  /* --- sign in --- */
  const first = await post(signin, "/api/signin", {
    firstName: "Smoke", lastName: "Test", phone: PHONE, channels: ["whatsapp"]
  });
  const session = await json(first);
  step("new client signs in and a record is created", first.status === 200 && session.created === true,
    session.error);
  if (session.clientId) {
    made.push(() => db().collection("clients").doc(session.clientId).delete());
  }
  const CLIENT = `Bearer client:${session.clientId}:${session.token}`;

  const again = await post(signin, "/api/signin", {
    firstName: "Smoke", lastName: "Test", phone: PHONE
  });
  const secondSession = await json(again);
  step("same number signs in as the same client, not a new one",
    secondSession.created === false && secondSession.clientId === session.clientId);

  const partner = await post(signin, "/api/signin", {
    firstName: "Partner", lastName: "Test", phone: PHONE
  });
  const partnerSession = await json(partner);
  const clientDoc = await db().collection("clients").doc(session.clientId).get();
  step("a partner on the same number joins the record rather than splitting it",
    partnerSession.clientId === session.clientId && (clientDoc.data()?.people ?? []).length === 2);

  const badToken = await get(slots, `/api/slots?date=${DATE}`,
    `Bearer client:${session.clientId}:wrong-token`);
  step("a wrong session token is refused", badToken.status === 401);

  /* --- index --- */
  await rebuildDays([DATE]);
  step("index rebuilt for the date", true);

  /* --- slots --- */
  const slotResponse = await get(slots, `/api/slots?date=${DATE}`, CLIENT);
  const slotBody = await json(slotResponse);
  const offered: Array<{ start: string; label: string }> = slotBody.slots ?? [];
  step("slots are offered", slotResponse.status === 200 && offered.length > 0,
    slotBody.error ?? `${offered.length} slots, first ${offered[0]?.label}`);

  /* --- book --- */
  const target = offered.find(s => s.label === "18:00") ?? offered[0];
  const booking = await post(book, "/api/book",
    { date: DATE, start: target.start, lessonType: "class", flexible: true }, CLIENT);
  const bookingBody = await json(booking);
  step("the booking is written", booking.status === 200, bookingBody.error ?? bookingBody.label);
  if (bookingBody.lessonId) {
    made.push(() => db().collection("lessons").doc(bookingBody.lessonId).delete());
  }

  const index = await db().collection("day_index").doc(DATE).get();
  const indexed = (index.data()?.lessons ?? []).some((l: any) => l.lessonId === bookingBody.lessonId);
  step("the index was updated inside the same transaction", indexed);

  const duplicate = await post(book, "/api/book",
    { date: DATE, start: target.start, lessonType: "class" }, CLIENT);
  step("booking the same slot twice is refused", duplicate.status === 409,
    (await json(duplicate)).error);

  const afterBooking = await json(await get(slots, `/api/slots?date=${DATE}`, CLIENT));
  step("the taken slot is no longer offered",
    !(afterBooking.slots ?? []).some((s: any) => s.start === target.start));

  /* --- coach move, and the outbox --- */
  const laterSlot = (afterBooking.slots ?? []).find((s: any) => s.label > target.label);
  if (laterSlot) {
    const moved = await post(coachAction, "/api/coach/action",
      { action: "move", lessonId: bookingBody.lessonId, start: laterSlot.start }, COACH);
    step("coach moves the lesson", moved.status === 200, (await json(moved)).error);

    const outbox = await json(await get(coachOutbox, "/api/coach/outbox", COACH));
    const entry = (outbox.items ?? []).find((i: any) => i.clientName === "Smoke Test");
    step("the move appears in the outbox with a contact link",
      !!entry && entry.links?.[0]?.href?.startsWith("https://wa.me/"),
      entry ? `${entry.summary} -> ${entry.links?.[0]?.href}` : "not found");
    if (entry) made.push(() => db().collection("notifications").doc(entry.id).delete());
  }

  /* --- cancel --- */
  const cancelled = await post(cancel, "/api/cancel", { lessonId: bookingBody.lessonId }, CLIENT);
  const cancelBody = await json(cancelled);
  step("the client cancels within the window", cancelled.status === 200, cancelBody.error);

  const gone = await db().collection("lessons").doc(bookingBody.lessonId).get();
  step("the lesson is removed from the calendar", !gone.exists);

  const log = await db().collection("booking_log").where("clientId", "==", session.clientId).get();
  step("the cancellation is kept in booking_log, not deleted", log.size === 1);
  for (const doc of log.docs) made.push(() => doc.ref.delete());

  const notifications = await db().collection("notifications")
    .where("clientId", "==", session.clientId).get();
  for (const doc of notifications.docs) made.push(() => doc.ref.delete());
}

try {
  await main();
} catch (error) {
  console.error("\n  ERROR", error instanceof Error ? error.message : error);
  failures++;
} finally {
  console.log("\nCleaning up…");
  for (const undo of made.reverse()) {
    try { await undo(); } catch (error) {
      console.error("  could not clean up:", error instanceof Error ? error.message : error);
    }
  }
  // Put the index back the way it was, so the test date shows no trace.
  await rebuildDays([DATE]).catch(() => {});
  console.log(failures === 0 ? "\nAll steps passed.\n" : `\n${failures} step(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}
