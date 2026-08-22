# Master Booker — Specification

**Lesson booking for Master Dance Studio**
**Version 1.0 — August 2026**

---

## 1. Purpose

Students book their own lessons on a website instead of texting back and forth. The system only ever offers slots that keep the coach's day packed, so the freedom given to students never turns into two-hour gaps between lessons.

It runs on the same Firebase project as the existing calendar app (`dance-calendar-d733f`). One database, no synchronisation layer. A lesson booked online appears on the calendar immediately; a lesson entered by hand on the calendar immediately blocks that slot online.

Scope for v1: **one coach (Vlad)**.

---

## 2. How booking works

### The problem

Availability is 16:00–21:00. A student books 18:00. A naive "only offer adjacent slots" rule would then refuse a 19:30 booking, even though in real life the coach would happily take it and slot someone into 18:45 later.

### The rule

Don't check adjacency. Check **how much idle time a booking would leave behind**.

```
span     = last lesson end − first lesson start
dead     = span − Σ(lesson durations) − (15 × breaks earned)
```

A booking is permitted when:

```
after.dead ≤ max(before.dead, budget)
```

Never make the day worse than it already is. The `max()` matters: a hole left by someone else's cancellation shouldn't block a student who wants to extend the end of the evening over a gap they didn't create.

### Worked example

Availability 16:00–21:00, 45-minute lessons, budget 45 min.

```
        16:00   17:00   18:00   19:00   20:00   21:00
          |-------|-------|-------|-------|-------|

A books                 [  A  ]                          dead 0     ok
B wants                             [  B  ]              dead 45    ok  ← allowed
                             ^^^^^^^
                             one lesson fits here
C books                      [  C  ]                     dead 0     gap closed
```

If B had asked for 19:45 instead, the gap would be 60 minutes — more than one lesson fills — and it is refused.

### Gap budget by lead time

The budget tightens as the day approaches, so early freedom converges on a packed schedule.

| Lead time to that day | Idle time permitted |
|---|---|
| More than 7 days | 90 min |
| 3–7 days | 45 min |
| 24h – 3 days | 0 — adjacent only |

Lead time is measured to the **start of that day's availability window**, not to the individual slot, so a whole day tightens at once rather than early slots locking before late ones.

### Breaks

15 minutes off after every 3 consecutive lessons. Lessons count by weight, so a 90-minute Double counts double:

| Type | Duration | Break weight |
|---|---|---|
| `class` | 45 min | 1 |
| `private60` | 60 min | 1 |
| `group` | 60 min | 1 |
| `double` | 90 min | 2 |

A break is only *earned* when it was required. Fifteen idle minutes after the first lesson of the day is dead time; fifteen idle minutes after the third is rest and costs nothing against the budget. Any gap of 15 minutes or more resets the consecutive counter.

Weights are configuration, not logic. If three 60-minute premium lessons back to back turns out to be brutal, set `private60` to 1.5 and it breaks after two instead.

### Timing rules

```
book cutoff     lessonStart − 24h    to the minute
cancel cutoff   lessonStart − 36h    to the minute
grace period    bookedAt + 30 min    cancellable regardless of cutoff
```

A Thursday 18:15 lesson can be booked until Wednesday 18:15 and cancelled until Tuesday 06:15. Both compared on timestamps — "tomorrow" never means "any time tomorrow".

Formally, cancellation is allowed when:

```
now ≤ lessonStart − 36h    OR    now ≤ graceUntil
```

No cap on bookings per client.

**The two windows are deliberately asymmetric.** Cancellation closing 12 hours earlier than booking means any hole a cancellation creates still has half a day of booking time left to fill it. Were both cutoffs 24h, a cancellation at the deadline would leave a gap nobody could ever close.

**The cost is a band where a booking cannot be undone.** Anything booked between −36h and −24h becomes final once its 30 minutes expire. This must be visible, not discovered:

- The confirmation step reads **"this booking can't be cancelled after 30 minutes"** whenever it falls inside 36h.
- During the grace period the client sees a live countdown, not a static rule.
- Past the cancel cutoff, a **request cancellation** button notifies the coach rather than presenting a dead end. The coach can always override.

Because bookings close at 24h, the grace period can never run past the lesson itself — the latest it can expire is 23.5 hours beforehand.

### Slot generation

Every 15-minute-aligned start time in the window is tested against the rules above, and whatever passes is offered. Around twenty candidates per day — trivial to compute, and it means there is exactly one definition of "legal", used for both display and confirmation. They can never drift apart.

Slots that *close* an existing gap are flagged and surfaced first.

---

## 3. Time and timezone

All lessons happen in Belgrade, so **every time displayed anywhere is `Europe/Belgrade`**, hardcoded, never the device's timezone. A lesson at 18:15 reads as 18:15 from Serbia, Berlin or Tokyo.

Storage stays as it already is: UTC ISO strings, e.g. `"2026-04-16T16:15:00.000Z"` for an 18:15 lesson. This was verified against the live calendar and is correct.

The existing calendar app renders in browser-local time. Patch it to use a fixed zone too, so the two apps can never disagree about what time a lesson is.

Availability windows are stored as **wall-clock strings** (`"16:00"`), never as UTC offsets, or the schedule drifts an hour at every daylight-saving change.

---

## 4. Architecture

### Shared database, not synced

Both apps read and write the same `lessons` collection. Firestore's `onSnapshot` gives live updates in both directions for free. There is no reconciliation logic because there is nothing to reconcile.

### The day index

Repeating lessons are stored as a **rule**, not as rows: one `lessons` document with `repeatWeekly: true` represents every future week, and `repeat_exceptions` carves holes out of it. Nothing in the database directly says "18:15 next Thursday is taken" — that fact only exists once the rule is expanded.

Expanding at booking time would be wrong: it needs an open-ended set of documents inside a transaction, which Firestore can't hold, and it would duplicate recurrence logic that already exists in the calendar app.

Instead, maintain a flattened document per day:

```
day_index/{YYYY-MM-DD}
  date       "2026-09-07"
  lessons    [ { id, start, end, lessonType, clientId?, source }, ... ]
  rebuiltAt  timestamp
```

A rebuild function expands repeats, applies exceptions, resolves overrides, and writes the finished explicit list. This gives:

- **Booking as a single-document transaction** — read one doc, validate, write. Atomic, no race conditions.
- **One place that understands recurrence.** The booking site never learns it.
- **The existing app unchanged.** It keeps writing `lessons` exactly as before; the index follows along.

**Range: 1 September 2026 → today + 90 days.** Because statistics have a hard floor at the season start, the index covers the whole relevant period rather than only the future — roughly 400 documents for one coach across a season. Booking and statistics then read the same flattened data, with no second code path.

Filter on `coach array-contains "Vlad"`, with that string in one config constant so adding a coach later is a config change rather than a search-and-replace.

Derived data can drift if a rebuild fails. Mitigate with a nightly full rebuild plus a `rebuiltAt` staleness check the booking page warns on.

### Where code runs

The project is on the Spark plan, so Cloud Functions would require upgrading to Blaze. Use **Netlify Functions** instead — the calendar app already deploys there — with the Firebase Admin SDK and a service account key in environment variables.

```
POST /api/book           validate + write, inside a transaction
POST /api/cancel         move to booking_log, rebuild
POST /api/rebuild-day    recompute one or more day indexes
```

Trigger rebuilds two ways, both: called by the apps after any save or delete for responsiveness, and on a scheduled function every 15 minutes for self-healing.

**Validation must be server-side.** Firestore security rules cannot express "no more than 3 consecutive lessons" or "leaves at most 45 minutes idle" — rules can't read sibling documents. Rules therefore deny client writes to `lessons` outright, and `/api/book` is the only way in.

---

## 5. Data model

All changes are additive. Nothing existing is renamed or restructured.

### Existing — `lessons`

| field | type | notes |
|---|---|---|
| `coach` | array of strings | display names, e.g. `["Vlad"]` |
| `start`, `end` | ISO string, UTC | |
| `occStart` | ISO string | identifies which occurrence, for exceptions |
| `lessonType` | string | `class` \| `double` \| `group` |
| `repeatWeekly` | boolean | |
| `title` | string | free text, human-entered |

### Existing — `repeat_exceptions`

| field | type |
|---|---|
| `parentId` | string → `lessons/{id}` |
| `occStart` | ISO string |
| `type` | string, e.g. `cancel` |

### New fields on `lessons`

Written only by bookings:

```
clientId    string  → clients/{id}
source      "booking"        absent on manually-created lessons
flexible    boolean          client agreed to be shifted ±1h
bookedAt    ISO string
graceUntil  ISO string       cancellable until this moment regardless of cutoff
```

`graceUntil` is set to `bookedAt + 30 min` on creation, and **reset by any coach-side change** so a client is never locked into a time they didn't choose.

Bookings must still write a sensible `title` in the same style as manual entries — that's what shows on the calendar.

### New — `clients`

Not "students": a bookable unit is often a couple. The calendar is full of them — *Mladenci*, *Nemanja i Ivana*, *Milan i Dragana*, *Dima/Sasha*. One record, one booking, one lesson.

```
clients/{id}
  displayName        "Nemanja i Ivana"
  people             [ { name, email }, ... ]     1 or 2 entries
  defaultLessonType  "class" | "private60"
  active             boolean
```

Any email in `people` can log in and sees the same bookings. Modelling a couple as two students who happen to share a slot would double-count every lesson in the statistics and break the one-client-one-booking assumption.

### New — `availability`

```
availability/{id}
  date        "2026-09-07"      or weekday + validFrom for recurring
  start, end  "16:00", "21:00"  Belgrade wall-clock
  gapBudget   number | null     null = use the lead-time table
```

### New — `booking_log`

Cancelled bookings move here rather than being deleted: original time, client, `cancelledAt`. Statistics need the history, but leaving ghosts in `lessons` would clutter the calendar and corrupt lesson counts.

### New — `config/stats`

```
epoch          "2026-09-01"
seasonStartMD  "09-01"
```

### New lesson type

`private60` — 60 minutes, for premium clients. Add it to the type filter in the calendar UI at the same time, or those lessons vanish whenever anyone filters by type. Don't file premium clients under `group` to borrow its duration; it muddies the statistics.

---

## 6. Screens

### Client

- **Login** — magic link via Firebase Auth. No passwords stored.
- **Book** — pick a date, see permitted slots for their own lesson length, confirm. A "can you shift ±1 hour if needed?" checkbox at confirmation.
- **My lessons** — upcoming bookings, cancel within the window, request outside it.
- **My stats** — lesson count, total hours, lessons per month, cancellations.

Client-facing views must never show another client's `title`, which contains real names. Occupied slots read simply as unavailable.

### Coach

- **Availability** — set windows per day, with weekly repeat. Optional per-day gap budget override.
- **Day view** — who's booked, with a **compact day** button that slides flexible clients together to close gaps and notifies them automatically.
- **Clients** — add, deactivate, set default lesson type, map historical titles to clients.
- **Requests** — approve out-of-window bookings and late cancellations.
- **Stats** — see §7.

### Coach override

Bookings are auto-confirmed; there is no approval queue. But the coach can move, reassign or cancel anything, and those edits **bypass the rules rather than being blocked by them**. Four lessons in a row with no break is allowed — the system warns and gets out of the way. The validator constrains clients, not the coach.

Two things this requires:

- **Notify the client on any coach-side change.** A lesson silently moving an hour is the worst failure this system could produce.
- **Catch edits made in the old calendar app**, which knows nothing about bookings. Detect moved lessons carrying `source: "booking"` during the index rebuild and fire notifications from there, so it works regardless of which app made the change.

**A coach-initiated change grants a fresh cancellation right.** Moving someone at 30 hours out puts them past their own cancel cutoff, stuck with a time they never chose — and the compact-day button does exactly this by design. Reset `graceUntil` on any coach edit.

Thirty minutes is too short here: the client didn't initiate the change and may be asleep. Twelve hours, capped at the lesson start, is a reasonable default. Note that clients who ticked the flexible box already consented to a ±1h shift, so this matters most for moves beyond that.

---

## 7. Statistics

No pay calculation. Counts, hours and patterns only.

**Season model:** a season runs 1 September → 31 August. Nothing before **1 September 2026** is counted. The dashboard defaults to the current season with a selector for later ones, so next year gives year-on-year comparison rather than a lifetime total that hides whether anything is improving.

### Coach

- Lessons and hours per week and month, split by type
- Per-client totals — who is actually turning up
- Cancellation and no-show rates
- **Window utilisation** — hours booked against hours offered, plus total idle time absorbed

Utilisation is the metric that closes the loop on the original problem. High utilisation with near-zero idle time means the gap budget can be loosened and students given more freedom; idle hours accumulating means tighten it.

### Client

- Lesson count and total hours
- Lessons per month over time
- Upcoming bookings and their own cancellation count

### Backfill

Lessons entered by hand between 1 September and launch carry no `clientId`. Existing titles are already clean names (*Zoran*, *Karina*, *Vesna*, *Настя*), so an admin screen listing distinct titles in range and letting you tap each to a client recovers them in minutes. Coach-side totals need no backfill — they come from the index regardless.

---

## 8. Build order

**Phase 0 — Confirm two schema details.** What values `repeat_exceptions.type` takes besides `cancel`, and whether repeating lessons carry a `repeatUntil` field. Both are one lookup each in the Firestore console.

**Phase 1 — Expansion and day index.** The load-bearing phase. Compare index output against the calendar UI across weeks containing repeats, cancelled occurrences and multi-coach lessons. Done when the two agree on every day. A bug here corrupts booking and statistics simultaneously.

**Phase 2 — Rules engine.** Already written and tested (`slotEngine.ts`, 16 passing cases). Needs the lead-time table from §2 and the `max(before.dead, budget)` comparison wired in, plus an adapter onto the index shape.

**Phase 3 — Client site.** Magic-link login, booking, cancellation, my-lessons.

**Phase 4 — Coach panel.** Availability, day view, compact day, clients, requests.

**Phase 5 — Statistics.** Both dashboards, plus the title-to-client backfill screen.

Phases 1 and 2 are independent — the engine can be finished against fake data while expansion is still being debugged.

---

## 9. Risks

| Risk | Consequence | Handling |
|---|---|---|
| Expansion bug | Corrupts booking and statistics at once | Phase 1 doesn't ship until it matches the UI exactly |
| Stale day index | Sells a slot that is actually taken | Scheduled rebuild + `rebuiltAt` staleness warning |
| Coach moves a booked lesson in the old app | Client arrives at the wrong time | Detect `source: "booking"` movement during rebuild, notify |
| Cancelled bookings hard-deleted | Reliability statistics silently meaningless | Move to `booking_log`, never delete |
| Deleted repeat series | Orphaned index entries | Rebuild on delete, plus nightly full rebuild |
| Service account key leaked | Full database write access | Netlify environment variable only, never in client code or git |
| Client sees another client's name | Privacy | Occupied slots render as unavailable, never as the `title` |
| Booking inside 36h is final | "I booked it and can't cancel" | Warn at confirmation, 30-min grace with live countdown |

---

## 10. Open

- Is a no-show tracked separately from a cancellation? Marking one requires a post-lesson action from the coach.
- Notification channel — email, or something clients will actually read.
