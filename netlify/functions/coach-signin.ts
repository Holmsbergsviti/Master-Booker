/* =====================================================================
   POST /api/coach/signin   { passcode }

   The coach panel shows every client's real name and can cancel anyone's
   lesson, so unlike the client site it is gated. One passcode, held in
   an environment variable, entered once per device.
   ===================================================================== */

import type { Config } from "@netlify/functions";
import { ApiError, handler, json, readJson, requirePost } from "./_lib/http.js";
import { requireCoach } from "./_lib/auth.js";

export default handler(async (req: Request) => {
  requirePost(req);
  const body = await readJson<{ passcode?: string }>(req);
  if (!body.passcode) throw new ApiError(400, "Enter the passcode.");

  // Verified through the same path every other coach endpoint uses,
  // rather than a second comparison that could drift from it.
  await requireCoach(new Request(req.url, {
    headers: { authorization: `Bearer coach:${body.passcode}` }
  }));

  return json({ ok: true, token: `coach:${body.passcode}` });
});

export const config: Config = { path: "/api/coach/signin" };
