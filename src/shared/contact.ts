/* =====================================================================
   Reaching a client.

   Nothing is sent automatically. Events accumulate in `notifications`,
   and the coach panel turns each one into a tap that opens the right
   app at the right number — because the coach knows what to say and a
   template would not.

   A client gives one number and says which apps it is on. The number is
   the same across all of them; the channels only decide which links to
   offer.
   ===================================================================== */

/** Serbia. Local numbers are written 064..., which is +381 64... */
export const DEFAULT_COUNTRY_CODE = "381";

import { dayKey, formatDayKeyLong, formatTime } from "./time.js";

export type Channel = "whatsapp" | "telegram" | "viber";

export const CHANNELS: ReadonlyArray<{ value: Channel; label: string }> = [
  { value: "whatsapp", label: "WhatsApp" },
  { value: "telegram", label: "Telegram" },
  { value: "viber",    label: "Viber" }
];

export function isChannel(value: string): value is Channel {
  return CHANNELS.some(c => c.value === value);
}

/**
 * Anything a person might type, reduced to E.164 ("+381641234567").
 * Returns null when there is nothing usable, so a half-typed number is
 * never stored as if it were reachable.
 */
export function normalisePhone(input: string, countryCode = DEFAULT_COUNTRY_CODE): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;

  // Spaces, dashes, brackets and dots are decoration.
  let digits = raw.replace(/[\s\-().]/g, "");
  if (!/^\+?\d+$/.test(digits)) return null;

  if (digits.startsWith("+")) {
    digits = digits.slice(1);
  } else if (digits.startsWith("00")) {
    // International prefix as dialled from a landline.
    digits = digits.slice(2);
  } else if (digits.startsWith("0")) {
    // A local number: the trunk 0 is replaced by the country code, never
    // kept alongside it.
    digits = countryCode + digits.slice(1);
  } else {
    // Already a country code, just missing its plus.
    digits = digits;
  }

  // A reachable mobile with its country code is at least ten digits;
  // anything shorter is a half-typed number, and E.164 caps at fifteen.
  // Storing a broken number is worse than refusing it, because the coach
  // finds out only when the message does not arrive.
  if (digits.length < 10 || digits.length > 15) return null;
  return `+${digits}`;
}

export interface ContactLink {
  channel: Channel;
  label: string;
  href: string;
}

/**
 * Where to tap. Each app wants the number in its own shape:
 * wa.me takes bare digits, Viber wants the plus percent-encoded, and
 * Telegram resolves by phone only through its own scheme — there is no
 * https link that opens a chat by number, so this one relies on the
 * Telegram app being installed.
 */
export function contactLinks(
  phone: string | null | undefined,
  channels: readonly string[] | null | undefined
): ContactLink[] {
  const normalised = phone ? normalisePhone(phone) : null;
  if (!normalised) return [];

  const digits = normalised.slice(1);
  const chosen = (channels ?? []).filter(isChannel);

  return chosen.map(channel => {
    switch (channel) {
      case "whatsapp":
        return { channel, label: "WhatsApp", href: `https://wa.me/${digits}` };
      case "telegram":
        return { channel, label: "Telegram", href: `tg://resolve?phone=${digits}` };
      case "viber":
        return { channel, label: "Viber", href: `viber://chat?number=${encodeURIComponent(normalised)}` };
    }
  });
}

/** "+381 64 123 4567" — grouped for reading aloud, not for dialling. */
export function formatPhone(phone: string | null | undefined): string {
  const normalised = phone ? normalisePhone(phone) : null;
  if (!normalised) return "";
  const digits = normalised.slice(1);
  if (!digits.startsWith(DEFAULT_COUNTRY_CODE)) return normalised;
  const local = digits.slice(DEFAULT_COUNTRY_CODE.length);
  const head = local.slice(0, 2);
  const rest = local.slice(2);
  // The common Serbian mobile is 2 + 7 digits, which reads as 3 + 4.
  // Grouping strictly in threes would leave a stranded single digit.
  const tail = rest.length === 7
    ? `${rest.slice(0, 3)} ${rest.slice(3)}`
    : rest.replace(/(\d{3})(?=\d)/g, "$1 ");
  return `+${DEFAULT_COUNTRY_CODE} ${head} ${tail}`.trim();
}

/** Plain-language description of a queued event, for the outbox. */
export function describeNotification(n: {
  kind?: string;
  from?: string | null;
  to?: string | null;
}): string {
  switch (n.kind) {
    case "lesson-moved":
      return n.from && n.to ? describeMove(n.from, n.to) : "Lesson moved";
    case "lesson-cancelled-by-coach":
      return "You cancelled their lesson";
    case "booking-cancelled":
      return "They cancelled a lesson";
    case "booking-confirmed":
      return "They booked a lesson";
    case "cancellation-requested":
      return "They asked to cancel — past the cutoff";
    case "request-approved":
      return "You approved their request";
    case "request-declined":
      return "You declined their request";
    default:
      return n.kind ?? "Update";
  }
}

/** Compact day moves lessons within a day, which is the common case, so
 *  naming the date twice is noise. Across days it is the whole point. */
function describeMove(fromIso: string, toIso: string): string {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (dayKey(from) === dayKey(to)) {
    return `Moved ${formatTime(from)} → ${formatTime(to)}, ${formatDayKeyLong(dayKey(to))}`;
  }
  return `Moved ${formatTime(from)} ${formatDayKeyLong(dayKey(from))}` +
         ` → ${formatTime(to)} ${formatDayKeyLong(dayKey(to))}`;
}

/** Which events the coach actually has to pass on. A client who booked
 *  online already knows they booked; a lesson the coach moved is the one
 *  that must never go unsaid. */
export function needsTelling(kind: string | undefined): boolean {
  return kind === "lesson-moved"
    || kind === "lesson-cancelled-by-coach"
    || kind === "request-approved"
    || kind === "request-declined";
}
