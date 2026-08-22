/* =====================================================================
   GET /api/coach/outbox

   Nothing sends messages on its own. When the coach changes a lesson,
   the event lands here with the client's number and a tap that opens the
   right app — the coach writes what to say, because a template would not
   know.

   The queue is the safety net: an event stays here until it is marked
   as told, so a lesson silently moving an hour cannot happen quietly.
   ===================================================================== */

import type { Config } from "@netlify/functions";
import type { ClientDoc } from "../../src/shared/types.js";
import { requireCoach } from "./_lib/auth.js";
import { handler, json, requireGet } from "./_lib/http.js";
import { db } from "./_lib/admin.js";
import { contactLinks, describeNotification, formatPhone, needsTelling } from "../../src/shared/contact.js";

interface NotificationDoc {
  kind?: string;
  clientId?: string | null;
  lessonId?: string | null;
  from?: string | null;
  to?: string | null;
  start?: string | null;
  createdAt?: string;
  deliveredAt?: string | null;
}

export default handler(async (req: Request) => {
  requireGet(req);
  await requireCoach(req);

  const includeDone = new URL(req.url).searchParams.get("all") === "1";

  const [notificationSnap, clientSnap] = await Promise.all([
    db().collection("notifications").where("deliveredAt", "==", null).get(),
    db().collection("clients").get()
  ]);

  const clients = new Map<string, ClientDoc>();
  for (const doc of clientSnap.docs) {
    clients.set(doc.id, { ...(doc.data() as Omit<ClientDoc, "id">), id: doc.id });
  }

  const items = notificationSnap.docs
    .map(doc => {
      const data = doc.data() as NotificationDoc;
      const client = data.clientId ? clients.get(data.clientId) : undefined;
      return {
        id: doc.id,
        kind: data.kind ?? "update",
        createdAt: data.createdAt ?? "",
        clientId: data.clientId ?? null,
        clientName: client?.displayName ?? "Unknown client",
        summary: describeNotification(data),
        // The whole point: which number, and where.
        phone: client?.phone ?? null,
        phoneLabel: formatPhone(client?.phone),
        links: contactLinks(client?.phone, client?.channels),
        // A client with no number yet is the case that must be visible,
        // not the one that quietly disappears from the list.
        reachable: contactLinks(client?.phone, client?.channels).length > 0,
        mustTell: needsTelling(data.kind)
      };
    })
    .filter(item => includeDone || item.mustTell)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return json({
    items,
    // Everything queued, so the panel can show a quieter count of the
    // events that are merely informational.
    pending: notificationSnap.size,
    unreachable: items.filter(i => !i.reachable).length
  });
});

export const config: Config = { path: "/api/coach/outbox" };
