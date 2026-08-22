import { beforeEach, describe, expect, it } from "vitest";

/** localStorage does not exist in Node; the module reads it at import. */
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
};

const { bearerToken, setClientSession, setCoachSession, useSession } =
  await import("../src/lib/session.js");

describe("which session a page uses", () => {
  beforeEach(() => {
    store.clear();
    setClientSession(null);
    setCoachSession(null);
    useSession("client");
  });

  it("sends the client token on the client site", () => {
    setClientSession({ clientId: "c1", token: "secret", displayName: "Ana" });
    expect(bearerToken()).toBe("client:c1:secret");
  });

  it("sends the coach token on the coach panel", () => {
    useSession("coach");
    setCoachSession("coach:passcode");
    expect(bearerToken()).toBe("coach:passcode");
  });

  it("keeps the two apart when both sessions exist at once", () => {
    // The coach books lessons too, and both apps share one origin and so
    // one localStorage. Choosing whichever token happened to be present
    // sent `coach:` credentials to the client endpoints, which rejected
    // them, cleared the session and asked for a fresh sign-in — a loop
    // with no way out.
    setClientSession({ clientId: "c1", token: "secret", displayName: "Ana" });
    setCoachSession("coach:passcode");

    useSession("client");
    expect(bearerToken()).toBe("client:c1:secret");

    useSession("coach");
    expect(bearerToken()).toBe("coach:passcode");
  });

  it("reports no token when this page's session is missing", () => {
    setCoachSession("coach:passcode");
    useSession("client");
    expect(bearerToken()).toBeNull();
  });
});
