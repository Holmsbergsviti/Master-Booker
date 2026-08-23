/* =====================================================================
   Staying signed in.

   The session is a token in localStorage and nothing else. There is no
   Firebase Auth here, no password and no email — signing in is a name
   and a phone number, once per device, and the browser remembers it
   until someone signs out.
   ===================================================================== */

const CLIENT_KEY = "masterBooker.session";
const COACH_KEY = "masterBooker.coach";

export interface ClientSession {
  clientId: string;
  token: string;
  displayName: string;
  /** Kept here so the booking controls can render before /api/me
   *  returns; it is only a default and the server always decides. */
  defaultLessonType?: string;
}

/** localStorage throws in private mode on some browsers rather than
 *  returning null, and a crash at boot would leave a blank page. */
function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* private mode: the session lasts this page load only */ }
}

let memoryClient: ClientSession | null = null;
let memoryCoach: string | null = null;

export function clientSession(): ClientSession | null {
  if (memoryClient) return memoryClient;
  const raw = read(CLIENT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ClientSession;
    if (!parsed?.clientId || !parsed?.token) return null;
    memoryClient = parsed;
    return parsed;
  } catch {
    return null;
  }
}

export function setClientSession(session: ClientSession | null): void {
  memoryClient = session;
  write(CLIENT_KEY, session ? JSON.stringify(session) : null);
}

export function coachSession(): string | null {
  return memoryCoach ?? (memoryCoach = read(COACH_KEY));
}

export function setCoachSession(token: string | null): void {
  memoryCoach = token;
  write(COACH_KEY, token);
}

/** The Authorization header value for whichever session is active. */
export type SessionKind = "client" | "coach";

let kind: SessionKind = "client";

/**
 * Which session this page uses. Declared once at boot by each app.
 *
 * It must not be inferred from what happens to be in storage. Both apps
 * live on one origin and therefore share localStorage, so a coach who
 * also books lessons has both sessions at once — and picking whichever
 * is present sent `Bearer coach:...` to the client endpoints, which
 * rejected it, cleared the session and asked them to sign in again, for
 * ever.
 */
export function useSession(value: SessionKind): void {
  kind = value;
}

/** The Authorization header value for this page's session. */
export function bearerToken(): string | null {
  if (kind === "coach") return coachSession();
  const client = clientSession();
  return client ? `client:${client.clientId}:${client.token}` : null;
}
