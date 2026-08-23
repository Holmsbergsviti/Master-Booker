/* =====================================================================
   POST /api/signin   { firstName, lastName, phone, channels }

   The whole of signing in. No password, no email, no link to click: a
   name and a phone number, once per device.

   The phone number is the identity. Type the same one on another device
   and you are the same person; type a new one and a new record is
   created. A couple sharing a number is one bookable unit, which is what
   the calendar has always assumed — Mladenci, Nemanja i Ivana — so the
   second partner to sign in joins the existing record rather than
   splitting the pair into two.
   ===================================================================== */

import type { Config } from "@netlify/functions";
import { randomBytes } from "node:crypto";
import type { ClientDoc } from "../../src/shared/types.js";
import { ApiError, handler, json, readJson, requirePost } from "./_lib/http.js";
import { db } from "./_lib/admin.js";
import { isChannel, normalisePhone } from "../../src/shared/contact.js";
import {
  checkSignIn, displayNameFrom, personIsListed, SIGN_IN_MESSAGES
} from "../../src/shared/identity.js";
import { DEFAULT_LESSON_TYPE } from "../../src/shared/config.js";

interface SignInBody {
  firstName?: string;
  lastName?: string;
  phone?: string;
  channels?: string[];
}

export default handler(async (req: Request) => {
  requirePost(req);
  const body = await readJson<SignInBody>(req);

  const problem = checkSignIn(body);
  if (problem) throw new ApiError(400, SIGN_IN_MESSAGES[problem]);

  const phone = normalisePhone(body.phone ?? "");
  if (!phone) throw new ApiError(400, SIGN_IN_MESSAGES["bad-phone"]);

  const fullName = displayNameFrom(body.firstName ?? "", body.lastName ?? "");
  const channels = (body.channels ?? []).filter(isChannel);

  const existing = await db().collection("clients").where("phone", "==", phone).limit(1).get();
  const found = existing.docs[0];

  if (found) {
    const client = { ...(found.data() as Omit<ClientDoc, "id">), id: found.id };
    if (client.active === false) throw new ApiError(403, "That account is inactive.");

    const update: Record<string, unknown> = {};

    // The partner signing in for the first time joins the record instead
    // of creating a second one against the same number.
    if (!personIsListed(client.people, fullName)) {
      update.people = [...(client.people ?? []), { name: fullName }];
    }
    // Channels are the client's to correct at any time; an empty list
    // means they did not touch it, not that they use nothing.
    if (channels.length > 0) update.channels = channels;

    // A record the coach created by hand may have no token yet.
    const token = client.token ?? newToken();
    if (!client.token) update.token = token;

    if (Object.keys(update).length > 0) {
      await found.ref.set(update, { merge: true });
    }

    return json({
      created: false,
      clientId: client.id,
      token,
      displayName: client.displayName,
      defaultLessonType: client.defaultLessonType ?? DEFAULT_LESSON_TYPE
    });
  }

  const token = newToken();
  const ref = db().collection("clients").doc();
  await ref.set({
    displayName: fullName,
    people: [{ name: fullName }],
    phone,
    channels,
    defaultLessonType: DEFAULT_LESSON_TYPE,
    active: true,
    token,
    createdAt: new Date().toISOString()
  });

  return json({
    created: true,
    clientId: ref.id,
    token,
    displayName: fullName,
    defaultLessonType: DEFAULT_LESSON_TYPE
  });
});

/** Opaque and unguessable, so a client id on its own is not a login. */
function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export const config: Config = { path: "/api/signin" };
