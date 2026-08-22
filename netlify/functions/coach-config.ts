/* =====================================================================
   GET /api/coach/config

   Availability windows and the client roster — the two lists the coach
   panel edits rather than the day it displays.
   ===================================================================== */

import type { Config } from "@netlify/functions";
import type { AvailabilityDoc, ClientDoc } from "../../src/shared/types.js";
import { requireCoach } from "./_lib/auth.js";
import { handler, json, requireGet } from "./_lib/http.js";
import { db } from "./_lib/admin.js";
import { loadAvailability } from "./_lib/store.js";

export default handler(async (req: Request) => {
  requireGet(req);
  await requireCoach(req);

  const [availability, clientSnap] = await Promise.all([
    loadAvailability(),
    db().collection("clients").orderBy("displayName").get()
  ]);

  return json({
    availability: availability.sort(sortWindows),
    clients: clientSnap.docs.map(d => ({ ...(d.data() as Omit<ClientDoc, "id">), id: d.id }))
  });
});

/** Dated overrides first, then the weekly pattern in week order. */
function sortWindows(a: AvailabilityDoc, b: AvailabilityDoc): number {
  if (a.date && b.date) return a.date.localeCompare(b.date);
  if (a.date) return -1;
  if (b.date) return 1;
  return (a.weekday ?? 0) - (b.weekday ?? 0) || a.start.localeCompare(b.start);
}

export const config: Config = { path: "/api/coach/config" };
