/* =====================================================================
   POST /api/rebuild-day   { date } | { dates: [...] } | { all: true }

   Called by both apps after any save or delete, for responsiveness. The
   scheduled rebuild below would get there on its own, but a coach who
   adds a lesson and immediately opens the booking page should not see
   the old day.
   ===================================================================== */

import type { Config } from "@netlify/functions";
import { handler, json, readJson, requirePost, ApiError } from "./_lib/http.js";
import { rebuildAll, rebuildDays } from "./_lib/store.js";
import { dayKeysBetween, indexRange } from "../../src/shared/dayIndex.js";

interface RebuildBody {
  date?: string;
  dates?: string[];
  from?: string;
  to?: string;
  all?: boolean;
}

export default handler(async (req: Request) => {
  requirePost(req);
  const body = await readJson<RebuildBody>(req);
  const now = new Date();

  if (body.all) {
    const result = await rebuildAll(now);
    return json({ ok: true, ...result });
  }

  let dates: string[] = [];
  if (body.from && body.to) dates = dayKeysBetween(body.from, body.to);
  else if (body.dates) dates = body.dates;
  else if (body.date) dates = [body.date];

  dates = dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (dates.length === 0) throw new ApiError(400, "Pass a date, a list of dates, or all: true.");

  // Never let a caller widen the index beyond the range it is defined
  // over, or stray documents accumulate outside what anything reads.
  const { from, to } = indexRange(now);
  const inRange = dates.filter(d => d >= from && d <= to);
  if (inRange.length === 0) return json({ ok: true, days: 0, lessons: 0, moved: [], skipped: dates.length });

  const result = await rebuildDays(inRange, now);
  return json({ ok: true, ...result, skipped: dates.length - inRange.length });
});

export const config: Config = { path: "/api/rebuild-day" };
