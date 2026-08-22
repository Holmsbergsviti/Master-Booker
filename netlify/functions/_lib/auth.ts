/* =====================================================================
   Who is calling.

   Two kinds of caller, two different bars.

   A client proves nothing beyond knowing their own name and phone
   number, which is the point: signing in is one form, once per device,
   and the worst case is somebody booking a lesson in a friend's name.
   Their session token is issued at sign-in and stored on their record.

   The coach is gated on a passcode, because that panel shows every
   client's real name and can cancel anyone's lesson.
   ===================================================================== */

import { timingSafeEqual } from "node:crypto";
import type { ClientDoc } from "../../../src/shared/types.js";
import { db } from "./admin.js";
import { ApiError } from "./http.js";

export interface ClientCaller {
  kind: "client";
  client: ClientDoc;
}

function bearer(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/i.exec(header.trim());
  if (!match) throw new ApiError(401, "Please sign in.");
  return match[1]!.trim();
}

/** The client whose session token this is. */
export async function callerFrom(req: Request): Promise<ClientCaller> {
  const token = bearer(req);
  const [prefix, clientId, secret] = token.split(":");
  if (prefix !== "client" || !clientId || !secret) {
    throw new ApiError(401, "Please sign in again.");
  }

  const doc = await db().collection("clients").doc(clientId).get();
  if (!doc.exists) throw new ApiError(401, "Please sign in again.");

  const client = { ...(doc.data() as Omit<ClientDoc, "id">), id: doc.id };
  // Compared in constant time so a token cannot be recovered a character
  // at a time by timing the response.
  if (!client.token || !safeEqual(client.token, secret)) {
    throw new ApiError(401, "Please sign in again.");
  }
  if (client.active === false) throw new ApiError(403, "That account is inactive.");

  return { kind: "client", client };
}

/** Convenience for the endpoints that only ever want the record. */
export async function clientFor(caller: ClientCaller): Promise<ClientDoc> {
  return caller.client;
}

export async function requireCoach(req: Request): Promise<void> {
  const token = bearer(req);
  const [prefix, passcode] = splitOnce(token, ":");
  if (prefix !== "coach" || !passcode) throw new ApiError(403, "Coach access only.");

  const expected = process.env.COACH_PASSCODE;
  if (!expected) {
    // Refusing everyone is the only safe response to a missing passcode.
    // An unset variable must never mean "let anyone in".
    throw new ApiError(500, "The coach passcode is not configured.");
  }
  if (!safeEqual(expected, passcode)) throw new ApiError(403, "That passcode is not right.");
}

/** True when the request carries a valid coach passcode. */
export async function isCoach(req: Request): Promise<boolean> {
  try {
    await requireCoach(req);
    return true;
  } catch {
    return false;
  }
}

export async function clientById(id: string): Promise<ClientDoc> {
  const doc = await db().collection("clients").doc(id).get();
  if (!doc.exists) throw new ApiError(404, "No such client.");
  return { ...(doc.data() as Omit<ClientDoc, "id">), id: doc.id };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which would itself leak
  // the length, so pad both to the same size first.
  if (left.length !== right.length) {
    const size = Math.max(left.length, right.length);
    return timingSafeEqual(pad(left, size), pad(right, size)) && false;
  }
  return timingSafeEqual(left, right);
}

function pad(buffer: Buffer, size: number): Buffer {
  const out = Buffer.alloc(size);
  buffer.copy(out);
  return out;
}

function splitOnce(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator);
  if (index === -1) return [value, ""];
  return [value.slice(0, index), value.slice(index + 1)];
}
