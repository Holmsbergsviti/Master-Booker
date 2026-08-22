/* =====================================================================
   The self-healing rebuild.

   Derived data drifts when a rebuild fails, and a stale index sells a
   slot that is actually taken. Both apps call /api/rebuild-day after
   every save, but a dropped request, a crash mid-batch or an edit made
   while offline would leave the index behind with nothing to notice it.

   Every 15 minutes: the near-term window, which is all booking reads.
   Once a night: everything, including the past, so the statistics floor
   at the season start stays correct too.
   ===================================================================== */

import type { Config } from "@netlify/functions";
import { rebuildAll, rebuildDays } from "./_lib/store.js";
import { dayKeysBetween, indexRange } from "../../src/shared/dayIndex.js";
import { addDayKey, dayKey, wallParts } from "../../src/shared/time.js";

export default async () => {
  const now = new Date();
  const hour = wallParts(now).hour;

  // A full rebuild walks ~400 documents; run it when nobody is booking.
  if (hour === 4) {
    const result = await rebuildAll(now);
    console.log("Nightly full rebuild", result.days, "days,", result.lessons, "lessons");
    return new Response("ok");
  }

  // Yesterday onward: a lesson moved late last night still needs its old
  // day corrected. Clamped to the epoch so a run before the season opens
  // cannot write day documents nothing reads.
  const { from: epoch, to } = indexRange(now);
  const yesterday = addDayKey(dayKey(now), -1);
  const from = yesterday < epoch ? epoch : yesterday;
  const result = await rebuildDays(dayKeysBetween(from, to), now);
  if (result.moved.length > 0) {
    console.log("Detected moved bookings during rebuild:", JSON.stringify(result.moved));
  }
  return new Response("ok");
};

export const config: Config = { schedule: "*/15 * * * *" };
