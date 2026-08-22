/* =====================================================================
   Shapes shared by the browser apps and the Netlify functions.
   Field names match what is already in Firestore — nothing is renamed.
   ===================================================================== */

/** A document in `lessons`, exactly as the calendar app writes it, plus
 *  the additive booking fields. */
export interface LessonDoc {
  id: string;
  /** Display names, e.g. ["Vlad"]. */
  coach: string[];
  /** ISO string, UTC. */
  start: string;
  /** ISO string, UTC. */
  end: string;
  /** Identifies which occurrence, for exceptions. */
  occStart?: string | null;
  lessonType?: string | null;
  title?: string | null;
  repeatWeekly?: boolean;
  /** ISO string. The calendar app's name for it — the spec guessed
   *  `repeatUntil`, which does not exist. */
  repeatEndDate?: string | null;
  /** Series-split lineage. Not used for expansion: children are ordinary
   *  standalone documents. */
  parentId?: string | null;

  /* --- written only by bookings --- */
  clientId?: string | null;
  source?: "booking" | null;
  /** Client agreed to be shifted +/- 1h. */
  flexible?: boolean;
  bookedAt?: string | null;
  /** Cancellable until this moment regardless of the cutoff. */
  graceUntil?: string | null;
}

/** A document in `repeat_exceptions`. */
export interface ExceptionDoc {
  id?: string;
  parentId: string;
  /** ISO string of the occurrence being carved out. */
  occStart: string;
  /** Only "cancel" is written by the calendar app today. */
  type: string;
}

/** One expanded occurrence — a concrete lesson at a concrete instant. */
export interface Occurrence {
  /** The lessons/{id} it came from. Not unique: a repeat yields many. */
  lessonId: string;
  /** ISO string, UTC. */
  start: string;
  /** ISO string, UTC. */
  end: string;
  /** ISO string identifying the occurrence within its series. */
  occStart: string;
  lessonType: string;
  coach: string[];
  title?: string | null;
  clientId?: string | null;
  source?: "booking" | null;
  flexible?: boolean;
  graceUntil?: string | null;
  repeatWeekly?: boolean;
}

/** A document in `day_index/{YYYY-MM-DD}`. The flattened truth both
 *  booking and statistics read. */
export interface DayIndexDoc {
  date: string;
  lessons: Occurrence[];
  /** ISO string. */
  rebuiltAt: string;
}

/** A document in `availability`. */
export interface AvailabilityDoc {
  id?: string;
  /** "2026-09-07" for a one-off window. */
  date?: string | null;
  /** 0 = Sunday ... 6 = Saturday, for a recurring window. */
  weekday?: number | null;
  /** "2026-09-01" — recurring windows apply from this date on. */
  validFrom?: string | null;
  validUntil?: string | null;
  /** Belgrade wall-clock, never a UTC offset, or the schedule drifts an
   *  hour at every daylight-saving change. */
  start: string;
  end: string;
  /** null = use the lead-time table. */
  gapBudget?: number | null;
  coach?: string;
  /** A closed day: an explicit dated override with no bookable time. */
  closed?: boolean;
}

/** A resolved window for one day, in Belgrade wall-clock. */
export interface DayWindow {
  date: string;
  start: string;
  end: string;
  gapBudget: number | null;
}

/** A document in `clients`. A bookable unit is often a couple: the
 *  calendar is full of them — Mladenci, Nemanja i Ivana, Dima/Sasha —
 *  and modelling a couple as two people who happen to share a slot would
 *  double-count every lesson and break one-client-one-booking. */
export interface ClientDoc {
  id: string;
  displayName: string;
  /** One or two people. Names only: there is no email anywhere. */
  people: Array<{ name: string }>;
  defaultLessonType: string;
  active: boolean;
  /** E.164, and the identity itself — signing in matches on this. */
  phone?: string | null;
  /** Which apps that number is reachable on: whatsapp | telegram | viber. */
  channels?: string[];
  /** Session secret, issued at sign-in. Never leaves the server except
   *  to the device that signed in. */
  token?: string;
  /** Historical calendar titles mapped to this client, for the backfill. */
  titleAliases?: string[];
  createdAt?: string;
}

/** A document in `booking_log`. Cancelled bookings move here rather than
 *  being deleted: statistics need the history. */
export interface BookingLogDoc {
  id?: string;
  clientId: string;
  lessonId: string;
  start: string;
  end: string;
  lessonType: string;
  title?: string | null;
  bookedAt?: string | null;
  cancelledAt: string;
  cancelledBy: "client" | "coach";
  reason?: string | null;
}

/** A document in `requests` — out-of-window bookings and late cancellations. */
export interface RequestDoc {
  id?: string;
  kind: "cancel" | "book";
  clientId: string;
  lessonId?: string;
  start?: string;
  message?: string | null;
  createdAt: string;
  status: "open" | "approved" | "declined";
  resolvedAt?: string | null;
}

/** A candidate start time offered to a client. */
export interface Slot {
  /** ISO string, UTC. */
  start: string;
  /** ISO string, UTC. */
  end: string;
  /** Belgrade wall-clock, e.g. "18:15". */
  label: string;
  /** Idle minutes the day would carry if this were booked. */
  deadAfter: number;
  /** True when booking this shrinks existing dead time — surfaced first. */
  closesGap: boolean;
}
