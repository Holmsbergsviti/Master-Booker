/* =====================================================================
   Request plumbing: JSON in, JSON out, and one place that decides what
   an error looks like to the caller.
   ===================================================================== */

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

/** Never leak an internal message to a client. Log it, return something
 *  a person can act on. */
export function fail(error: unknown): Response {
  if (error instanceof ApiError) {
    return json({ error: error.message, code: error.code ?? null }, error.status);
  }

  // A deployment missing its credentials is not an unexpected failure,
  // it is a setup step nobody has done yet — and "Something went wrong"
  // gives whoever deployed it nothing to act on. The *name* of an
  // environment variable is not a secret; its value is, and that is
  // never included.
  if (error instanceof Error && /^Missing environment variable /.test(error.message)) {
    console.error("Configuration error:", error.message);
    return json({
      error: `The server is not configured: ${error.message}.`,
      code: "not-configured"
    }, 503);
  }

  console.error("Unhandled function error:", error);
  return json({ error: "Something went wrong. Please try again." }, 500);
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ApiError(400, "Expected a JSON body.");
  }
}

export function requirePost(req: Request): void {
  if (req.method !== "POST") throw new ApiError(405, "Use POST.");
}

export function requireGet(req: Request): void {
  if (req.method !== "GET") throw new ApiError(405, "Use GET.");
}

/** Wrap a handler so every thrown ApiError becomes a proper response. */
export function handler(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try {
      return await fn(req);
    } catch (error) {
      return fail(error);
    }
  };
}
