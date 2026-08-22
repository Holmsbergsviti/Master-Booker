/* =====================================================================
   GET /api/coach/stats?season=2026

   Counts, hours and patterns. No pay calculation.

   Everything is read from the day index, the same flattened data booking
   reads, so a lesson can never count in one place and not the other —
   and coach-side totals need no backfill, because they come from the
   index whether a lesson has a clientId or not.
   ===================================================================== */

import type { Config } from "@netlify/functions";
import type { BookingLogDoc, ClientDoc } from "../../src/shared/types.js";
import { requireCoach } from "./_lib/auth.js";
import { handler, json, requireGet } from "./_lib/http.js";
import { db } from "./_lib/admin.js";
import { loadAvailability, loadDayIndexRange } from "./_lib/store.js";
import { coachStats, currentSeason, seasonForYear, seasonsAvailable } from "../../src/shared/stats.js";
import { dayKey } from "../../src/shared/time.js";

export default handler(async (req: Request) => {
  requireGet(req);
  await requireCoach(req);

  const now = new Date();
  const requested = new URL(req.url).searchParams.get("season");
  const season = requested ? seasonForYear(Number(requested)) : currentSeason(now);

  const [days, availability, logSnap, clientSnap] = await Promise.all([
    loadDayIndexRange(season.from, season.to),
    loadAvailability(),
    db().collection("booking_log").get(),
    db().collection("clients").get()
  ]);

  const clients = clientSnap.docs.map(d => ({ ...(d.data() as Omit<ClientDoc, "id">), id: d.id }));
  const clientNames = new Map(clients.map(c => [c.id, c.displayName]));

  const stats = coachStats({
    season,
    days,
    cancellations: logSnap.docs.map(d => d.data() as BookingLogDoc),
    availability,
    clientNames,
    // Utilisation counts what has actually happened, not what is on the
    // books for next month.
    through: dayKey(now)
  });

  // The backfill list: titles the calendar carries that no client owns
  // yet. Already clean names, so tapping each to a client recovers them
  // in minutes.
  const unmapped = new Map<string, number>();
  for (const day of days) {
    for (const occ of day.lessons ?? []) {
      if (occ.clientId || !occ.title) continue;
      unmapped.set(occ.title, (unmapped.get(occ.title) ?? 0) + 1);
    }
  }

  return json({
    season,
    seasons: seasonsAvailable(now),
    stats,
    clients: clients.map(c => ({
      id: c.id,
      displayName: c.displayName,
      active: c.active,
      defaultLessonType: c.defaultLessonType,
      people: c.people ?? [],
      phone: c.phone ?? null
    })),
    unmappedTitles: [...unmapped.entries()]
      .map(([title, count]) => ({ title, count }))
      .sort((a, b) => b.count - a.count)
  });
});

export const config: Config = { path: "/api/coach/stats" };
