/* =====================================================================
   GET /api/me

   Everything the client site needs about the person signed in: who they
   are, what they have booked, what they can still cancel, and their own
   statistics.

   Only their own lessons are ever returned. Another client's `title`
   contains a real name and never crosses this boundary — occupied slots
   are simply absent from the list of slots on offer.
   ===================================================================== */

import type { Config } from "@netlify/functions";
import type { BookingLogDoc } from "../../src/shared/types.js";
import { callerFrom, clientFor } from "./_lib/auth.js";
import { handler, json, requireGet } from "./_lib/http.js";
import { db } from "./_lib/admin.js";
import { loadDayIndexRange } from "./_lib/store.js";
import { clientStats, seasonForYear, seasonOf, seasonsAvailable } from "../../src/shared/stats.js";
import { canCancel } from "../../src/shared/slotEngine.js";
import { dayKey, formatTime } from "../../src/shared/time.js";
import { indexRange } from "../../src/shared/dayIndex.js";

export default handler(async (req: Request) => {
  requireGet(req);

  const now = new Date();
  const caller = await callerFrom(req);
  const client = await clientFor(caller);

  const url = new URL(req.url);
  const requested = url.searchParams.get("season");
  const season = requested ? seasonForYear(Number(requested)) : seasonOf(dayKey(now));

  const range = indexRange(now);
  const from = season.from < range.from ? range.from : season.from;
  const to = season.to > range.to ? range.to : season.to;

  const [days, logSnap] = await Promise.all([
    loadDayIndexRange(from, to),
    db().collection("booking_log").where("clientId", "==", client.id).get()
  ]);

  const cancellations = logSnap.docs.map(d => d.data() as BookingLogDoc);
  const stats = clientStats(client.id, days, cancellations, season, now);

  const upcoming = stats.upcoming.map(occ => {
    const start = new Date(occ.start);
    const cancellable = canCancel(start, occ.graceUntil, now);
    return {
      lessonId: occ.lessonId,
      start: occ.start,
      end: occ.end,
      date: dayKey(start),
      label: formatTime(start),
      lessonType: occ.lessonType,
      flexible: !!occ.flexible,
      // Only online bookings are the client's to cancel; a lesson the
      // coach entered by hand is theirs to change.
      mine: occ.source === "booking",
      cancellable: occ.source === "booking" && cancellable.allowed,
      viaGrace: cancellable.viaGrace,
      graceUntil: occ.graceUntil ?? null
    };
  });

  return json({
    client: {
      id: client.id,
      displayName: client.displayName,
      defaultLessonType: client.defaultLessonType,
      people: client.people?.map(p => ({ name: p.name })) ?? [],
      phone: client.phone ?? null,
      channels: client.channels ?? []
    },
    season,
    seasons: seasonsAvailable(now),
    upcoming,
    stats: {
      count: stats.total.count,
      minutes: stats.total.minutes,
      byType: stats.total.byType,
      byMonth: stats.byMonth,
      cancellations: stats.cancellations
    }
  });
});

export const config: Config = { path: "/api/me" };
