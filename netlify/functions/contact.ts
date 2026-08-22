/* =====================================================================
   POST /api/contact   { phone, channels }

   The client tells the coach how to reach them. They are the only ones
   who know which apps their number is actually on, so they enter it
   rather than the coach guessing.

   Scoped to the caller's own record: the token names the client, the
   body never does.
   ===================================================================== */

import type { Config } from "@netlify/functions";
import { callerFrom, clientFor } from "./_lib/auth.js";
import { ApiError, handler, json, readJson, requirePost } from "./_lib/http.js";
import { db } from "./_lib/admin.js";
import { formatPhone, isChannel, normalisePhone } from "../../src/shared/contact.js";

interface ContactBody {
  phone?: string;
  channels?: string[];
}

export default handler(async (req: Request) => {
  requirePost(req);

  const body = await readJson<ContactBody>(req);
  const caller = await callerFrom(req);
  const client = await clientFor(caller);

  const phone = body.phone ? normalisePhone(body.phone) : null;
  if (body.phone && !phone) {
    throw new ApiError(400, "That doesn't look like a phone number. Try 064 123 4567.");
  }

  const channels = (body.channels ?? []).filter(isChannel);
  if (phone && channels.length === 0) {
    // A number nobody knows how to reach is the same as no number.
    throw new ApiError(400, "Tick at least one app your number is on.");
  }

  await db().collection("clients").doc(client.id).set({ phone, channels }, { merge: true });

  return json({ ok: true, phone, phoneLabel: formatPhone(phone), channels });
});

export const config: Config = { path: "/api/contact" };
