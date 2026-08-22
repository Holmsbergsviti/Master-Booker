/* =====================================================================
   GET /api/slots?date=YYYY-MM-DD

   What the client may book that day. Computed here rather than in the
   browser for one reason: it is the same call /api/book makes to decide
   whether to accept, so the list shown and the list accepted are the
   same list. They can never drift apart.

   Occupied times are never described. A client sees the slots they can
   have; another client's `title` contains a real name and never leaves
   the server.
   ===================================================================== */

import type { Config } from "@netlify/functions";
import { callerFrom, clientFor } from "./_lib/auth.js";
import { ApiError, handler, json, requireGet } from "./_lib/http.js";
import { assertIndexedDate, loadAvailability, loadDayIndex } from "./_lib/store.js";
import { windowForDay } from "../../src/shared/availability.js";
import { isStale } from "../../src/shared/dayIndex.js";
import { offeredSlots } from "../../src/shared/slotEngine.js";
import { lessonSpec } from "../../src/shared/config.js";

export default handler(async (req: Request) => {
  requireGet(req);

  const url = new URL(req.url);
  const date = url.searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, "Pass a date as YYYY-MM-DD.");

  const now = new Date();
  assertIndexedDate(date, now);

  const caller = await callerFrom(req);
  const client = await clientFor(caller);

  const requested = url.searchParams.get("lessonType") ?? client.defaultLessonType;
  const spec = lessonSpec(requested);
  if (!spec.bookable) throw new ApiError(400, "That lesson type cannot be booked online.");

  const [availability, index] = await Promise.all([loadAvailability(), loadDayIndex(date)]);

  const window = windowForDay(availability, date);
  if (!window) {
    return json({ date, window: null, slots: [], stale: false, lessonType: requested });
  }

  const slots = offeredSlots({
    date,
    window,
    existing: index?.lessons ?? [],
    lessonType: requested,
    now
  });

  return json({
    date,
    window: { start: window.start, end: window.end },
    lessonType: requested,
    durationMins: spec.mins,
    slots,
    // Derived data can drift when a rebuild fails. Say so rather than
    // quietly selling a slot that is actually taken.
    stale: isStale(index?.rebuiltAt, now)
  });
});

export const config: Config = { path: "/api/slots" };
