# Master Booker

Lesson booking for Master Dance Studio. Students book their own lessons instead of
texting back and forth, and the system only ever offers slots that keep the coach's
day packed.

Runs on the same Firebase project as the existing calendar app (`dance-calendar-d733f`).
One database, no synchronisation layer: a lesson booked online appears on the calendar
immediately, and a lesson entered by hand on the calendar immediately blocks that slot
online.

See [`master-booker-spec.md`](master-booker-spec.md) for the design and the reasoning
behind it.

---

## What is here

| Phase | Status |
|---|---|
| 0 — Confirm schema details | Done, confirmed against the live database |
| 1 — Expansion and day index | Done, diffed against the calendar app on real data |
| 2 — Rules engine | Done, 34 tests |
| 3 — Client site | Done |
| 4 — Coach panel | Done |
| 5 — Statistics and backfill | Done |

`npm test` runs 112 offline tests. `npm run test:live` additionally runs a read-only
audit against the real database — see below.

```
src/shared/       pure domain logic — no Firebase, no DOM, runs in both browser and function
  config.ts         every tunable: budgets, cutoffs, break weights, lesson types
  time.ts           Europe/Belgrade, pinned; nothing here reads the runtime's zone
  expand.ts         weekly repeats + exceptions -> concrete occurrences
  dayIndex.ts       occurrences -> one flattened document per day
  slotEngine.ts     dead time, gap budget, slot generation, booking/cancel windows
  availability.ts   which window is in force on a given day
  compact.ts        slide flexible clients together to close gaps
  stats.ts          season model, tallies, window utilisation

netlify/functions/  server-side validation; the only way a booking gets written
src/client/         the student site
src/coach/          the coach panel
tests/              73 tests, including a differential test against the calendar app
```

## Phase 0, answered

Both questions were answerable from `petarCalendar/app.js`, and both were then confirmed
against the live database by `npm run test:live` (684 lessons, 149 exceptions):

- **`repeat_exceptions.type`** — only `"cancel"` is ever written (`app.js:1426`), and all
  149 live exceptions are `cancel`. The expansion here ignores any other value rather than
  guessing, so a kind added later cannot silently start deleting lessons from the index.
- **`repeatUntil`** — does not exist, on any of the 684 live documents. The field is
  **`repeatEndDate`**, an ISO string set to the end of the local day (`app.js:1828`).
  The spec guessed the wrong name.

The audit also found four lessons with **no `lessonType` at all**. Both apps default those
to `class`, so they agree; it is recorded here because a fifth type appearing later would
change that silently.

Two further things the spec did not mention, both handled:

- Lessons can carry **`parentId`**, lineage from an "edit all future" series split. It
  plays no part in expansion — the child is an ordinary standalone document.
- There is an existing **`students`** collection, unrelated to the new `clients`. Left
  untouched.

## The daylight-saving trap

The calendar app advances weekly repeats with `setDate`, which preserves the *browser's*
wall clock across a DST change — a Thursday 18:15 lesson stays 18:15 through October.
The exception key is the resulting UTC instant.

Run that same arithmetic on a Netlify function, which is UTC, and every occurrence after
the change lands an hour off, producing `occStart` strings that no longer match the
exceptions the browser wrote. Cancelled lessons would quietly reappear.

So `src/shared/time.ts` pins Europe/Belgrade explicitly and never touches local time, and
the test suite deliberately runs under `America/New_York` — a helper that reached for the
runtime's zone fails there and would have passed in production, which is the worst way
round. `tests/expand.test.ts` then diffs the output against a verbatim copy of the
calendar app's expansion running under `Europe/Belgrade`, week by week for a full season.

`npm run test:live` runs the same diff against the **live** database — currently 60 weeks
and 540 occurrences, identical. That is Phase 1's exit criterion, met on real data rather
than on fixtures. It needs `serviceAccountKey.json` in the repo root (gitignored) and only
ever reads.

## Running it

```bash
npm install
npm test
npm run dev
```

The client site is at `/`, the coach panel at `/coach/`.

## Deploying

1. **Create a service account key**: Firebase console → Project settings → Service
   accounts → Generate new private key.
2. **Set environment variables on Netlify** (never in the repo — a leaked key is full
   database write access):

   | Variable | Value |
   |---|---|
   | `FIREBASE_PROJECT_ID` | `dance-calendar-d733f` |
   | `FIREBASE_CLIENT_EMAIL` | from the key file |
   | `FIREBASE_PRIVATE_KEY` | from the key file, `\n` escapes intact |
   | `COACH_PASSCODE` | the coach panel's passcode |

3. **Deploy.** `netlify.toml` builds with Vite and serves the functions at `/api/*`.
4. **Build the index once**: `POST /api/rebuild-day` with `{"all": true}`. Nothing is
   bookable until day documents exist — a missing document is treated as "not ready",
   never as "free".
5. **Set availability** in the coach panel. No window means nothing to book.

Clients need no setting up at all — they sign in themselves, and the record is
created on the spot. The coach panel is for correcting names, merging couples and
deactivating people, not for onboarding.

The scheduled function keeps the index healthy on its own: the near-term window every
15 minutes, everything once a night at 04:00 Belgrade.

## Seasons and the booking window

Two different windows, which used to be one constant and should not have been:

- **`SEASON_EPOCH`** (1 September 2026) is the statistics floor. A season runs
  1 September to 31 August, and nothing before the epoch counts toward one.
- **The day index** runs from whichever is earlier, today or the epoch, to today + 90
  days. It has to reach back to the epoch once the season is under way, because the
  statistics read the same flattened documents.

Conflating them meant no date before 1 September could be booked at all: the index had
no document for it, and a missing document is deliberately read as "not ready", never as
"free". Bookings before the season opens now work; they simply do not count toward a
season total.

## Signing in

There is no password and no email anywhere.

**Clients** type their first name, surname and phone number once, and the browser
remembers them. The phone number is the identity: type the same one on another device
and you are the same person. Type a new one and a new record is created on the spot.

A couple sharing a number is one bookable unit, which is what the calendar has always
assumed — *Mladenci*, *Nemanja i Ivana*, *Dima/Sasha*. The second partner to sign in
joins the existing record rather than splitting the pair into two, because modelling a
couple as two people who happen to share a slot would double-count every lesson.

Names are folded before matching — case, spacing and Serbian diacritics, so someone on a
foreign keyboard typing "Milos" still matches "Miloš".

This is deliberately weak. Knowing somebody's name and number is enough to book in their
name, and that is an acceptable trade for a studio where everyone knows everyone. The
**coach panel** is the exception: it shows every client's real name and can cancel any
lesson, so it is gated on `COACH_PASSCODE`. If that variable is unset every coach
endpoint refuses — an absent passcode never means "let anyone in".

Neither app uses the Firebase client SDK. Everything goes through the functions, which is
why the whole client bundle is about 8 kB.

## Before deploying `firestore.rules`

The rules close every collection Master Booker owns, including `clients`, which holds
phone numbers and session tokens — no browser can read it at any price.

What stays open is the calendar app's own `lessons` and `repeat_exceptions`, and only
because that app writes to Firestore directly with no sign-in at all. Closing them today
stops the coach entering a lesson by hand.

The order that works:

1. Add Firebase Auth sign-in to the calendar app.
2. Put the coach's address in `isCoach()` in `firestore.rules`.
3. Swap the calendar collections' `allow read, write: if true` for `if isCoach()`.

## Telling clients when something changes

Nothing is sent automatically, deliberately. A client gives one phone number and says
which apps it is on — WhatsApp, Telegram, Viber, any combination — and every coach-side
change queues an entry in `notifications`.

The coach panel's **To tell** tab turns each entry into the client's name, what changed,
their number, and a tap that opens the right app. Marking it told stamps `deliveredAt`,
so the same message is never sent twice or assumed sent and never made. A client with no
number on file is shown as unreachable rather than dropping quietly off the list.

The queue is what makes "a lesson never moves silently" true: an entry stays there until
someone acts on it. That includes moves the coach makes in the *old calendar app*, which
knows nothing about bookings — the index rebuild diffs its own previous output to spot
them.

## Still outstanding

These are in the spec and are not done, because they change the *other* repository:

- **Patch the calendar app to render in a fixed zone.** It renders in browser-local time
  today. Until it is patched, the two apps can disagree about what time a lesson is
  whenever the coach's device is not on Belgrade time.
- **Add `private60` to the calendar's `LESSON_TYPES`.** Without it, every premium lesson
  vanishes from the calendar whenever anyone filters by type, and its 60 minutes are
  drawn as 45.
- **Call `/api/rebuild-day` from the calendar app** after each save and delete. The
  scheduled rebuild covers it within 15 minutes regardless; this is for responsiveness.

Open questions from the spec, unresolved by design:

- Whether a no-show is tracked separately from a cancellation. Marking one needs a
  post-lesson action from the coach, which does not exist yet.
- The notification channel. Events are written durably to a `notifications` collection
  with a `deliveredAt` field so nothing is lost; a sender can drain it once the channel
  is decided.
