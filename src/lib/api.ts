/* =====================================================================
   Talking to the functions.

   Every call carries the session token. The browser sends who it is; it
   never names the client it is acting for, so a tampered request still
   cannot book on somebody else's behalf.
   ===================================================================== */

import { bearerToken } from "./session.js";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null = null) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}, anonymous = false): Promise<T> {
  const token = anonymous ? null : bearerToken();
  if (!anonymous && !token) throw new ApiError("Please sign in.", 401);

  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {})
    }
  });

  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }

  if (!response.ok && response.status !== 202) {
    const record = body as { error?: string; code?: string } | null;
    throw new ApiError(record?.error ?? "Something went wrong.", response.status, record?.code ?? null);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => call<T>(path),
  post: <T>(path: string, body: unknown) =>
    call<T>(path, { method: "POST", body: JSON.stringify(body) }),
  /** Sign-in, which by definition has no session yet. */
  signIn: <T>(path: string, body: unknown) =>
    call<T>(path, { method: "POST", body: JSON.stringify(body) }, true)
};
