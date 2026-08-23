/* =====================================================================
   GET /api/month?month=YYYY-MM

   How many slots each day of a month actually has, so the calendar can
   grey out the days worth nothing rather than letting a student tap
   through six of them to find that out.

   Computed with the same generator the day view and /api/book use — a
   day is offered here only if a booking would really be accepted there.
   A cheaper proxy, like "does this day have an availability window",
   would light up days whose slots are all taken or all inside the
   24-hour cutoff.
   ===================================================================== */

import type { Config } from "@netlify/functions";
import { callerFrom, clientFor } from "./_lib/auth.js";
import { ApiError, handler, json, requireGet } from "./_lib/http.js";
import { loadAvailability, loadDayIndexRange } from "./_lib/store.js";
import { windowForDay } from "../../src/shared/availability.js";
import { dayKeysBetween, indexRange } from "../../src/shared/dayIndex.js";
import { offeredSlots } from "../../src/shared/slotEngine.js";
import { lessonSpec } from "../../src/shared/config.js";
import type { Slot } from "../../src/shared/types.js";
import { parseDayKey } from "../../src/shared/time.js";

export default handler(async (req: Request) => {
  requireGet(req);

  const url = new URL(req.url);
  const month = url.searchParams.get("month") ?? "";
  if (!/^\d{4}-\d{2}$/.test(month)) throw new ApiError(400, "Pass a month as YYYY-MM.");

  const now = new Date();
  const caller = await callerFrom(req);
  const client = await clientFor(caller);

  const lessonType = url.searchParams.get("lessonType") ?? client.defaultLessonType;
  const spec = lessonSpec(lessonType);
  if (!spec.bookable) throw new ApiError(400, "That lesson type cannot be booked online.");

  const first = `${month}-01`;
  const { year, month: monthNumber } = parseDayKey(first);
  // Day zero of the next month is the last day of this one, whatever its
  // length and whether or not it is a leap year.
  const last = `${month}-${String(new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()).padStart(2, "0")}`;

  // Clip to what the index actually covers; outside it nothing is
  // bookable and there are no documents to read.
  const range = indexRange(now);
  const from = first < range.from ? range.from : first;
  const to = last > range.to ? range.to : last;

  if (from > to) {
    return json({ month, first, last, lessonType, days: [] });
  }

  const [availability, indexed] = await Promise.all([
    loadAvailability(),
    loadDayIndexRange(from, to)
  ]);
  const byDate = new Map(indexed.map(day => [day.date, day]));

  const days = dayKeysBetween(from, to).map(date => {
    const window = windowForDay(availability, date);
    if (!window) return { date, count: 0, closesGap: false };

    const slots = offeredSlots({
      date,
      window,
      existing: byDate.get(date)?.lessons ?? [],
      lessonType,
      now
    });
    return {
      date,
      count: slots.length,
      closesGap: slots.some(slot => slot.closesGap)
    };
  });

  // The page always needs the times for the first day it will land on,
  // and asking for them separately meant a second round trip before
  // anything appeared. A round trip costs ~120ms whatever it carries, so
  // the day the caller is about to select rides along with the month.
  let firstSlots: { date: string; window: { start: string; end: string }; slots: Slot[] } | null = null;
  if (url.searchParams.get("withSlots") === "first") {
    const wanted = url.searchParams.get("on");
    const target = wanted && days.some(d => d.date === wanted && d.count > 0)
      ? wanted
      : days.find(d => d.count > 0)?.date;

    if (target) {
      const window = windowForDay(availability, target);
      if (window) {
        firstSlots = {
          date: target,
          window: { start: window.start, end: window.end },
          slots: offeredSlots({
            date: target,
            window,
            existing: byDate.get(target)?.lessons ?? [],
            lessonType,
            now
          })
        };
      }
    }
  }

  return json({
    month,
    first,
    last,
    lessonType,
    durationMins: spec.mins,
    // The bounds the calendar may page to, so it cannot walk off into
    // months that hold nothing.
    earliest: range.from,
    latest: range.to,
    days,
    firstSlots
  });
});

export const config: Config = { path: "/api/month" };
