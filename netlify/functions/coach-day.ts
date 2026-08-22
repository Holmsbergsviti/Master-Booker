/* =====================================================================
   GET /api/coach/day?date=YYYY-MM-DD

   The coach's view of a day: who is booked, under their real names,
   which is exactly what the client-facing endpoints must never return.
   ===================================================================== */

import type { Config } from "@netlify/functions";
import type { ClientDoc, RequestDoc } from "../../src/shared/types.js";
import { requireCoach } from "./_lib/auth.js";
import { ApiError, handler, json, requireGet } from "./_lib/http.js";
import { db } from "./_lib/admin.js";
import { loadAvailability, loadDayIndex } from "./_lib/store.js";
import { windowForDay } from "../../src/shared/availability.js";
import { isStale } from "../../src/shared/dayIndex.js";
import { deadTime, gapBudget, toIntervals } from "../../src/shared/slotEngine.js";
import { compactDay } from "../../src/shared/compact.js";
import { dayTimeToUtc, formatTime, lessonMinutes } from "../../src/shared/time.js";

export default handler(async (req: Request) => {
  requireGet(req);
  await requireCoach(req);

  const date = new URL(req.url).searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, "Pass a date as YYYY-MM-DD.");

  const now = new Date();
  const [availability, index, clientSnap, requestSnap] = await Promise.all([
    loadAvailability(),
    loadDayIndex(date),
    db().collection("clients").get(),
    db().collection("requests").where("status", "==", "open").get()
  ]);

  const clients = new Map<string, ClientDoc>();
  for (const doc of clientSnap.docs) {
    clients.set(doc.id, { ...(doc.data() as Omit<ClientDoc, "id">), id: doc.id });
  }

  const window = windowForDay(availability, date);
  const lessons = (index?.lessons ?? []).map(occ => ({
    ...occ,
    label: formatTime(new Date(occ.start)),
    minutes: lessonMinutes(occ.start, occ.end),
    clientName: occ.clientId ? clients.get(occ.clientId)?.displayName ?? null : null,
    booked: occ.source === "booking"
  }));

  const metric = window ? deadTime(toIntervals(index?.lessons ?? [], date)) : null;

  return json({
    date,
    window: window ? { start: window.start, end: window.end, gapBudget: window.gapBudget } : null,
    lessons,
    dead: metric?.dead ?? 0,
    restCredited: metric?.restCredited ?? 0,
    budget: window ? gapBudget(dayTimeToUtc(date, window.start), now, window.gapBudget) : 0,
    // A preview, never applied here: the coach sees who would move
    // before anyone is notified.
    compact: window
      ? compactDay({ date, windowStart: window.start, lessons: index?.lessons ?? [] })
      : { moves: [], deadBefore: 0, deadAfter: 0, saved: 0 },
    requests: requestSnap.docs.map(d => {
      const data = d.data() as RequestDoc;
      return {
        ...data,
        id: d.id,
        clientName: clients.get(data.clientId)?.displayName ?? null
      };
    }),
    stale: isStale(index?.rebuiltAt, now),
    rebuiltAt: index?.rebuiltAt ?? null
  });
});

export const config: Config = { path: "/api/coach/day" };
