/* =====================================================================
   Who a person is, for signing in.

   No passwords and no email. A client types their name, surname and
   phone number; if that matches someone already on file they are signed
   in as them, otherwise a new record is created. The browser remembers
   it afterwards, so this happens once per device.

   The phone number is the identity. Names are how people are addressed,
   not how they are matched — they get typed differently every time
   ("Miloš", "Milos", "  milos  ") and a couple sharing one number is a
   single bookable unit anyway.
   ===================================================================== */

/** Fold the ways the same name gets typed into one comparable form:
 *  case, padding, doubled spaces, and Serbian diacritics — someone on a
 *  phone keyboard abroad will type "Milos" for "Miloš". */
export function normaliseName(input: string): string {
  return (input ?? "")
    .trim()
    .toLowerCase()
    // Đ and đ are letters in their own right and do not decompose.
    .replace(/đ/g, "d")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ");
}

/** "  nemanja  petrOVIĆ " -> "Nemanja Petrović". Kept as typed apart from
 *  spacing and capitalisation, because this is what the coach reads on
 *  the calendar. */
export function displayNameFrom(firstName: string, lastName: string): string {
  return [firstName, lastName]
    .map(part => (part ?? "").trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .map(titleCase)
    .join(" ");
}

function titleCase(part: string): string {
  return part
    .split(/([ -])/)
    .map(chunk => chunk.length > 1
      ? chunk.charAt(0).toLocaleUpperCase("sr") + chunk.slice(1).toLocaleLowerCase("sr")
      : chunk)
    .join("");
}

/** True when this person is already listed on the record. */
export function personIsListed(
  people: ReadonlyArray<{ name: string }> | null | undefined,
  fullName: string
): boolean {
  const wanted = normaliseName(fullName);
  return (people ?? []).some(p => normaliseName(p.name) === wanted);
}

export interface SignInDetails {
  firstName: string;
  lastName: string;
  phone: string;
}

export type SignInProblem = "no-first-name" | "no-last-name" | "bad-phone";

/** What is missing, or null when the form is usable. Checked on both
 *  sides: the browser for a quick message, the function because the
 *  browser is not to be trusted. */
export function checkSignIn(details: Partial<SignInDetails>): SignInProblem | null {
  if (!(details.firstName ?? "").trim()) return "no-first-name";
  if (!(details.lastName ?? "").trim()) return "no-last-name";
  return null;
}

export const SIGN_IN_MESSAGES: Record<SignInProblem, string> = {
  "no-first-name": "Please enter your first name.",
  "no-last-name": "Please enter your surname.",
  "bad-phone": "That doesn't look like a phone number. Try 064 123 4567."
};
