/* =====================================================================
   The client site: sign in, book, cancel, see your own numbers.

   Every time shown here is Belgrade, from the shared time layer, never
   the device's zone. A student travelling reads the same 18:15 the coach
   does.
   ===================================================================== */

import "../style.css";
import type { Slot } from "../shared/types.js";
import { api, ApiError } from "../lib/api.js";
import {
  clientSession, setClientSession, useSession, type ClientSession
} from "../lib/session.js";
import { $, barChart, clear, el, show, toast, wireTheme } from "../lib/ui.js";
import { choiceDialog, confirmDialog } from "../lib/dialog.js";
import { LESSON_TYPES, lessonSpec } from "../shared/config.js";
import { addDayKey, countdown, dayKey, formatDayKeyLong, relativeTime } from "../shared/time.js";
import { indexRange } from "../shared/dayIndex.js";
import { formatHours } from "../shared/stats.js";
import { CHANNELS } from "../shared/contact.js";
import { checkSignIn, SIGN_IN_MESSAGES } from "../shared/identity.js";
import { CANCEL_CUTOFF_HOURS } from "../shared/config.js";

/* ---------- shapes the functions return ---------- */

interface SlotsResponse {
  date: string;
  window: { start: string; end: string } | null;
  lessonType: string;
  durationMins: number;
  slots: Slot[];
  stale: boolean;
}

interface UpcomingLesson {
  lessonId: string;
  occStart: string;
  repeatWeekly: boolean;
  start: string;
  end: string;
  date: string;
  label: string;
  lessonType: string;
  flexible: boolean;
  mine: boolean;
  cancellable: boolean;
  viaGrace: boolean;
  graceUntil: string | null;
}

interface MeResponse {
  client: {
    id: string; displayName: string; defaultLessonType: string;
    people: Array<{ name: string }>;
    phone: string | null;
    channels: string[];
  };
  season: { label: string; from: string; to: string };
  upcoming: UpcomingLesson[];
  stats: {
    count: number;
    minutes: number;
    byType: Record<string, number>;
    byMonth: Array<{ key: string; count: number }>;
    cancellations: number;
  };
}

interface BookResponse {
  lessonId: string;
  start: string;
  label: string;
  graceUntil: string;
  finalAfterGrace: boolean;
  repeatWeekly?: boolean;
  weeks?: number;
  skipped?: Array<{ date: string; message: string }>;
}

/* ---------- state ---------- */

let me: MeResponse | null = null;
let selected: Slot | null = null;
let currentSlots: SlotsResponse | null = null;
let countdownTimer: number | undefined;

/* ---------- boot ---------- */

// Before any request: this page is the client site, whatever else the
// browser may also be signed into.
useSession("client");

wireTheme($("themeToggle"));
renderChannelPicker($("signinChannels"), []);

// Deferred to a microtask, not called outright.
//
// Module-level `const`s further down this file — the date input, the
// selects — are still in their temporal dead zone while the top of the
// module is executing, and start() reaches them. Calling it directly
// threw "Cannot access 'X' before initialization" and rendered a blank
// page, but only for someone who already had a stored session, since
// otherwise start() returns before touching them.
//
// A microtask runs after all top-level code has finished, so every
// declaration exists by then regardless of where it appears.
queueMicrotask(() => void start());

async function start(): Promise<void> {
  const session = clientSession();
  if (!session) {
    showSignedOut();
    return;
  }
  try {
    // The booking view needs the lesson types and a month. Both come
    // without /api/me: the types are configuration and the default is
    // already in the session, so the calendar can be fetched straight
    // away instead of queuing behind a request it does not need.
    fillLessonTypes(session.defaultLessonType);
    showSignedIn();

    // The month carries the first day's times with it, so this is the
    // only request between opening the page and seeing something.
    // "My lessons" and the stats load alongside rather than in front.
    await Promise.all([
      openFirstBookableDay(),
      refresh().catch(reportSessionError)
    ]);
  } catch (error) {
    // A token the server no longer recognises means the record was
    // removed or reset; ask them to sign in again rather than leaving a
    // page that fails on every action.
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      setClientSession(null);
      showSignedOut();
      notice($("loginNotice"), error.message, "warn");
      return;
    }
    toast(error instanceof Error ? error.message : "Could not load your bookings.", "error");
  }
}

function reportSessionError(error: unknown): void {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    setClientSession(null);
    showSignedOut();
    notice($("loginNotice"), error.message, "warn");
    return;
  }
  toast(error instanceof Error ? error.message : "Could not load your bookings.", "error");
}

/** The bookable types are configuration, not server state. */
function fillLessonTypes(preferred?: string): void {
  if (typeSelect.options.length > 0) return;
  for (const [value, spec] of Object.entries(LESSON_TYPES)) {
    if (!spec.bookable) continue;
    const option = el("option", undefined, `${spec.label} · ${spec.mins} min`);
    option.value = value;
    typeSelect.append(option);
  }
  if (preferred) typeSelect.value = preferred;
}

function showSignedIn(): void {
  show($("loginView"), false);
  show($("appView"), true);
  show($("signOut"), true);
}

function showSignedOut(): void {
  show($("loginView"), true);
  show($("appView"), false);
  show($("signOut"), false);
  $("who").textContent = "";
  me = null;
}

/* ---------- sign in ---------- */

$("signIn").addEventListener("click", async () => {
  const firstName = $<HTMLInputElement>("firstName").value;
  const lastName = $<HTMLInputElement>("lastName").value;
  const phone = $<HTMLInputElement>("signinPhone").value;

  // Checked here for a quick message, and again on the server because
  // the browser is not to be trusted.
  const problem = checkSignIn({ firstName, lastName, phone });
  if (problem) {
    notice($("loginNotice"), SIGN_IN_MESSAGES[problem], "error");
    return;
  }

  const button = $<HTMLButtonElement>("signIn");
  button.disabled = true;
  try {
    const session = await api.signIn<ClientSession & { created: boolean }>("/api/signin", {
      firstName, lastName, phone, channels: pickedChannels("signinChannels")
    });
    setClientSession({
      clientId: session.clientId,
      token: session.token,
      displayName: session.displayName,
      defaultLessonType: session.defaultLessonType
    });
    fillLessonTypes(session.defaultLessonType);
    showSignedIn();
    await Promise.all([openFirstBookableDay(), refresh()]);
    toast(session.created
      ? `Welcome, ${session.displayName}.`
      : `Welcome back, ${session.displayName}.`, "success");
  } catch (error) {
    notice($("loginNotice"),
      error instanceof Error ? error.message : "Could not sign you in.", "error");
  } finally {
    button.disabled = false;
  }
});

$("signOut").addEventListener("click", () => {
  setClientSession(null);
  showSignedOut();
});

/** Channel chips, shared by the sign-in form and the details tab. */
function renderChannelPicker(host: HTMLElement, selected: readonly string[]): void {
  clear(host);
  for (const channel of CHANNELS) {
    const button = el("button", "btn small", channel.label);
    button.type = "button";
    button.dataset.channel = channel.value;
    button.classList.add(selected.includes(channel.value) ? "primary" : "ghost");
    button.addEventListener("click", () => {
      button.classList.toggle("primary");
      button.classList.toggle("ghost");
    });
    host.append(button);
  }
}

/* ---------- tabs ---------- */

for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  tab.addEventListener("click", () => {
    for (const other of document.querySelectorAll(".tab")) other.classList.remove("active");
    tab.classList.add("active");
    const view = tab.dataset.view;
    show($("bookView"), view === "book");
    show($("lessonsView"), view === "lessons");
    show($("detailsView"), view === "details");
    show($("statsView"), view === "stats");
  });
}

/**
 * Land on something useful.
 *
 * Bookings close 24 hours ahead, so nothing today is bookable and the
 * month always opens on tomorrow at the earliest. From there, select the
 * first day that actually has openings rather than the first day of the
 * month — otherwise a student's first sight is an empty slot area under
 * a date that was never going to work, and they have to hunt.
 *
 * Looks one month ahead at most: if a coach has no availability at all
 * there is nothing to find, and paging forever would just hammer the
 * function.
 */
async function openFirstBookableDay(): Promise<void> {
  const today = dayKey(new Date());
  const tomorrow = addDayKey(today, 1);
  const start = tomorrow > indexRange(new Date()).from ? tomorrow : indexRange(new Date()).from;

  await loadMonth(start.slice(0, 7), { withSlots: true });
  let candidate = firstFreeDay(start);

  if (!candidate) {
    await stepMonth(1, { withSlots: true });
    candidate = firstFreeDay(`${visibleMonth}-01`);
  }
  if (!candidate) {
    // Nothing bookable either month: stay put and let renderSlots say so
    // rather than leaving the page silently blank.
    renderCalendar();
    return;
  }

  selectedDate = candidate;
  renderCalendar();

  // Already in hand if the month returned it, which is the usual case.
  if (monthData?.firstSlots?.date === candidate) {
    currentSlots = {
      date: candidate,
      window: monthData.firstSlots.window,
      lessonType: monthData.lessonType,
      durationMins: monthData.durationMins,
      slots: monthData.firstSlots.slots,
      stale: false
    };
    renderSlots();
    return;
  }
  await loadSlots();
}

/** The earliest day on or after `from` with at least one free slot. */
function firstFreeDay(from: string): string | null {
  const days = (monthData?.days ?? [])
    .filter(day => day.date >= from && day.count > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  return days[0]?.date ?? null;
}

/* ---------- the calendar ---------- */

interface MonthDay { date: string; count: number; closesGap: boolean; }
interface MonthResponse {
  month: string;
  earliest: string;
  latest: string;
  lessonType: string;
  durationMins: number;
  days: MonthDay[];
  /** The times for the day the page is about to land on, sent with the
   *  month so opening the page costs one request rather than two. */
  firstSlots: { date: string; window: { start: string; end: string }; slots: Slot[] } | null;
}

const typeSelect = $<HTMLSelectElement>("bookType");

/** The month on screen, as YYYY-MM. */
let visibleMonth = "";
let monthData: MonthResponse | null = null;
let selectedDate = "";

typeSelect.addEventListener("change", async () => {
  // Lesson length changes which slots exist, so both views are stale.
  await loadMonth(visibleMonth);
  if (selectedDate) await loadSlots();
});

$("calToggle").addEventListener("click", () => {
  const button = $("calToggle");
  const open = button.getAttribute("aria-expanded") !== "false";
  button.setAttribute("aria-expanded", String(!open));
  $("calBody").classList.toggle("collapsed", open);
});

$("calPrev").addEventListener("click", () => void stepMonth(-1));
$("calNext").addEventListener("click", () => void stepMonth(1));

async function stepMonth(delta: number, options: { withSlots?: boolean } = {}): Promise<void> {
  const [year, month] = visibleMonth.split("-").map(Number);
  const shifted = new Date(Date.UTC(year!, month! - 1 + delta, 1));
  await loadMonth(`${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}`, options);
}

async function loadMonth(month: string, options: { withSlots?: boolean } = {}): Promise<void> {
  visibleMonth = month;
  try {
    monthData = await api.get<MonthResponse>(
      `/api/month?month=${encodeURIComponent(month)}` +
      `&lessonType=${encodeURIComponent(typeSelect.value)}` +
      (options.withSlots ? "&withSlots=first" : "")
    );
  } catch (error) {
    monthData = null;
    toast(error instanceof Error ? error.message : "Could not load the month.", "error");
  }
  renderCalendar();
}

function renderCalendar(): void {
  const label = $("calMonthLabel");
  const grid = $("calGrid");
  const weekdays = $("calWeekdays");
  clear(grid);

  if (weekdays.childElementCount === 0) {
    // Monday first, matching the calendar app and local convention.
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
      weekdays.append(el("span", undefined, day));
    }
  }

  const [year, month] = visibleMonth.split("-").map(Number);
  label.textContent = monthName(year!, month!);

  const bookable = new Map((monthData?.days ?? []).map(d => [d.date, d]));
  const today = dayKey(new Date());

  // Blank cells so the 1st lands under its weekday.
  const firstWeekday = (new Date(Date.UTC(year!, month! - 1, 1)).getUTCDay() + 6) % 7;
  for (let i = 0; i < firstWeekday; i++) {
    const filler = el("button", "cal-day outside");
    filler.type = "button";
    filler.disabled = true;
    filler.tabIndex = -1;
    grid.append(filler);
  }

  const daysInMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${visibleMonth}-${pad(day)}`;
    const info = bookable.get(date);
    const free = (info?.count ?? 0) > 0;

    // A day the index covers at all is selectable, even with nothing
    // free: tapping it explains why and offers the next date that works,
    // which beats a dead cell that does nothing when pressed.
    const reachable = !!info;

    const cell = el("button", `cal-day${free ? "" : " empty"}`, String(day));
    cell.type = "button";
    cell.disabled = !reachable;
    if (date === today) cell.classList.add("today");
    if (date === selectedDate) cell.classList.add("selected");
    if (info?.closesGap) cell.classList.add("closes");

    cell.setAttribute("aria-label",
      `${formatDayKeyLong(date)}${free ? `, ${info!.count} times free` : ", nothing free"}`);

    if (reachable) {
      cell.addEventListener("click", () => {
        selectedDate = date;
        selected = null;
        renderCalendar();
        void loadSlots();
      });
    }
    grid.append(cell);
  }

  const nav = monthData;
  $<HTMLButtonElement>("calPrev").disabled = !nav || `${visibleMonth}-01` <= nav.earliest;
  $<HTMLButtonElement>("calNext").disabled = !nav || `${visibleMonth}-28` >= nav.latest;
}

function monthName(year: number, month: number): string {
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, 1)));
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/* ---------- slots ---------- */

$("cancelPick").addEventListener("click", () => {
  selected = null;
  renderSlots();
});

$("confirmBook").addEventListener("click", async () => {
  if (!selected || !currentSlots) return;
  const button = $<HTMLButtonElement>("confirmBook");
  button.disabled = true;
  try {
    const result = await api.post<BookResponse>("/api/book", {
      date: currentSlots.date,
      start: selected.start,
      lessonType: currentSlots.lessonType,
      flexible: $<HTMLInputElement>("flexible").checked,
      repeatWeekly: $<HTMLInputElement>("repeatWeekly").checked
    });

    if (result.repeatWeekly) {
      toast(`Booked ${result.weeks} week${result.weeks === 1 ? "" : "s"} at ${result.label}.`, "success");
      // Never let a partial series pass as a complete one: say which
      // weeks could not be had rather than quietly booking fewer.
      if (result.skipped && result.skipped.length > 0) {
        toast(`${result.skipped.length} week${result.skipped.length === 1 ? " was" : "s were"} already taken: ` +
          result.skipped.slice(0, 3).map(s => formatDayKeyLong(s.date)).join(", ") +
          (result.skipped.length > 3 ? "…" : ""), "info");
      }
    } else {
      toast(`Booked for ${result.label} on ${formatDayKeyLong(currentSlots.date)}.`, "success");
    }
    $<HTMLInputElement>("repeatWeekly").checked = false;
    selected = null;
    await refresh();
    await Promise.all([loadSlots(), loadMonth(visibleMonth)]);
  } catch (error) {
    // A refused booking is nearly always someone else having taken the
    // slot, so reload rather than leaving a stale list on screen.
    toast(error instanceof Error ? error.message : "Could not book that time.", "error");
    await loadSlots();
  } finally {
    button.disabled = false;
  }
});

async function loadSlots(): Promise<void> {
  if (!selectedDate) return;
  selected = null;

  const host = $("slotHost");
  clear(host);
  host.append(el("p", "empty", "Loading…"));
  show($("confirmPanel"), false);

  try {
    currentSlots = await api.get<SlotsResponse>(
      `/api/slots?date=${encodeURIComponent(selectedDate)}&lessonType=${encodeURIComponent(typeSelect.value)}`
    );

    // Work out the fallback date before drawing, so the empty state can
    // name it immediately rather than appearing and then changing.
    lookaheadFreeDay = null;
    if (currentSlots.slots.length === 0) {
      const inView = (monthData?.days ?? []).some(day => day.date > selectedDate && day.count > 0);
      if (!inView) lookaheadFreeDay = await findLaterFreeDay(selectedDate);
    }

    renderSlots();
  } catch (error) {
    clear(host);
    notice($("slotNotice"), error instanceof Error ? error.message : "Could not load times.", "error");
  }
}

function renderSlots(): void {
  const host = $("slotHost");
  const noticeHost = $("slotNotice");
  clear(host);
  show(noticeHost, false);
  show($("confirmPanel"), !!selected);

  const data = currentSlots;
  if (!data) return;

  // No window at all and a window with nothing left in it are the same
  // thing to a student: not today, so when? The difference matters to
  // the coach, not to someone trying to book a lesson.
  if (!data.window || data.slots.length === 0) {
    renderNothingFree(host, !data.window);
    return;
  }

  // Derived data can drift when a rebuild fails. Say so rather than
  // quietly selling a slot that may already be taken.
  if (data.stale) {
    notice(noticeHost,
      "These times were last checked a while ago — your booking will still be verified when you confirm.",
      "warn");
  }



  host.append(el("p", "sub muted-line", formatDayKeyLong(data.date)));

  // One chronological grid. Splitting a studio's 16:00-21:00 evening
  // into "Day" and "Evening" put a heading above two times and another
  // above three, which is more furniture than the list it organises.
  const grid = el("div", "slot-grid");
  for (const slot of [...data.slots].sort((a, b) => a.label.localeCompare(b.label))) {
    const button = el("button", `slot${slot.closesGap ? " closes" : ""}`, slot.label);
    button.type = "button";
    if (selected?.start === slot.start) button.classList.add("selected");
    button.addEventListener("click", () => {
      selected = slot;
      renderSlots();
      renderConfirm();
    });
    grid.append(button);
  }
  host.append(grid);

  if (data.slots.some(s => s.closesGap)) {
    const legend = el("p", "slot-legend");
    legend.append(el("span", "dot"), document.createTextNode("Closes a gap in the coach's day"));
    host.append(legend);
  }

  if (selected) renderConfirm();
}

/**
 * A day with nothing on it.
 *
 * Says so plainly, then does the work of finding the next date that
 * works rather than leaving someone to tap through the month looking for
 * one. Bookings close 24 hours ahead, so "today" is routinely empty and
 * this is the first thing many students will see.
 */
function renderNothingFree(host: HTMLElement, notTeaching = false): void {
  const empty = el("div", "nothing-free");
  empty.append(el("p", "nothing-free-title", notTeaching
    ? "Your coach isn't teaching this day"
    : "There are no available spots for this day"));

  const next = nextFreeDay(selectedDate);
  if (!next) {
    empty.append(el("p", "nothing-free-sub",
      "Nothing is free in the months ahead either. Your coach may not have opened bookings yet."));
    host.append(empty);
    return;
  }

  const sub = el("p", "nothing-free-sub");
  sub.append(
    document.createTextNode("Next available date:"),
    el("br"),
    el("strong", undefined, formatDayKeyLong(next))
  );
  empty.append(sub);

  const jump = el("button", "btn primary", "Go to the nearest date");
  jump.type = "button";
  jump.addEventListener("click", async () => {
    jump.disabled = true;
    try {
      // The next free day may be in a month that is not on screen.
      if (next.slice(0, 7) !== visibleMonth) await loadMonth(next.slice(0, 7));
      selectedDate = next;
      selected = null;
      renderCalendar();
      await loadSlots();
    } finally {
      jump.disabled = false;
    }
  });
  empty.append(jump);
  host.append(empty);
}

/** The soonest day after `from` with something free, looking into later
 *  months when the loaded one has nothing left. */
function nextFreeDay(from: string): string | null {
  const inView = (monthData?.days ?? [])
    .filter(day => day.date > from && day.count > 0)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  if (inView) return inView.date;
  return lookaheadFreeDay;
}

/** Filled in by loadSlots when the visible month runs dry, so the empty
 *  state can name a date without blocking its own render on a fetch. */
let lookaheadFreeDay: string | null = null;

async function findLaterFreeDay(from: string): Promise<string | null> {
  let month = from.slice(0, 7);
  // Three months is the whole booking horizon; beyond that there is
  // nothing indexed to find.
  for (let i = 0; i < 3; i++) {
    const [year, monthNumber] = month.split("-").map(Number);
    const shifted = new Date(Date.UTC(year!, monthNumber! - 1 + 1, 1));
    month = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}`;
    if (monthData && month > monthData.latest.slice(0, 7)) return null;

    try {
      const ahead = await api.get<MonthResponse>(
        `/api/month?month=${encodeURIComponent(month)}&lessonType=${encodeURIComponent(typeSelect.value)}`
      );
      const found = ahead.days.filter(day => day.count > 0).sort((a, b) => a.date.localeCompare(b.date))[0];
      if (found) return found.date;
    } catch {
      return null;
    }
  }
  return null;
}

function renderConfirm(): void {
  if (!selected || !currentSlots) return;
  show($("confirmPanel"), true);

  const spec = lessonSpec(currentSlots.lessonType);
  $("confirmHeading").textContent =
    `${spec.label} at ${selected.label}, ${formatDayKeyLong(currentSlots.date)}`;

  // The band between -36h and -24h is one where a booking cannot be
  // undone. That has to be visible here, not discovered afterwards.
  const start = new Date(selected.start);
  const final = start.getTime() - Date.now() < CANCEL_CUTOFF_HOURS * 3_600_000;
  const warning = $("finalWarning");
  show(warning, final);
  if (final) {
    warning.textContent =
      "This booking can't be cancelled after 30 minutes. It's inside the 36-hour cancellation window.";
  }
}

/* ---------- my lessons ---------- */

async function refresh(): Promise<void> {
  me = await api.get<MeResponse>("/api/me");
  $("who").textContent = me.client.displayName;

  fillLessonTypes(me.client.defaultLessonType);

  renderLessons();
  renderDetails();
  renderStats();
}

/* ---------- my details ---------- */

/** The client is the only one who knows which apps their number is on,
 *  so they say, rather than the coach guessing and messaging into the
 *  void when a lesson has to move. */
function renderDetails(): void {
  if (!me) return;
  $<HTMLInputElement>("phone").value = me.client.phone ?? "";
  renderChannelPicker($("channelChips"), me.client.channels ?? []);
}

function pickedChannels(hostId: string): string[] {
  return [...document.querySelectorAll<HTMLElement>(`#${hostId} [data-channel]`)]
    .filter(node => node.classList.contains("primary"))
    .map(node => node.dataset.channel!);
}

function renderLessons(): void {
  const host = $("lessonsHost");
  clear(host);
  if (!me) return;

  if (me.upcoming.length === 0) {
    host.append(el("p", "empty", "Nothing booked yet."));
    return;
  }

  for (const lesson of me.upcoming) {
    const row = el("div", "row");
    const left = el("div", "grow");
    left.append(
      el("div", "time", `${lesson.label} · ${formatDayKeyLong(lesson.date)}`),
      el("div", "sub",
        `${lessonSpec(lesson.lessonType).label}` +
        (lesson.repeatWeekly ? " · every week" : "") +
        (lesson.flexible ? " · flexible" : "") +
        ` · ${relativeTime(new Date(), new Date(lesson.start))}`)
    );
    row.append(left);

    if (!lesson.mine) {
      row.append(el("span", "pill", "Added by coach"));
    } else if (lesson.cancellable) {
      const button = el("button", "btn ghost small", "Cancel");
      button.addEventListener("click", () => cancelLesson(lesson, false));
      row.append(button);

      // During the grace period the client sees a live countdown, not a
      // static rule — "30 minutes" means nothing once ten have passed.
      if (lesson.viaGrace && lesson.graceUntil) {
        const timer = el("span", "countdown");
        timer.dataset.until = lesson.graceUntil;
        row.insertBefore(timer, button);
      }
    } else {
      const button = el("button", "btn ghost small", "Request cancellation");
      button.addEventListener("click", () => cancelLesson(lesson, true));
      row.append(button);
    }

    host.append(row);
  }

  startCountdowns();
}

async function cancelLesson(lesson: UpcomingLesson, isRequest: boolean): Promise<void> {
  const when = `${lesson.label} on ${formatDayKeyLong(lesson.date)}`;
  let scope: "one" | "series" = "one";

  if (isRequest) {
    const agreed = await confirmDialog({
      title: "Ask your coach to cancel?",
      message: `${when} is past the cancellation cutoff, so your coach has to approve it. They'll be in touch.`,
      confirmLabel: "Send request"
    });
    if (!agreed) return;
  } else if (lesson.repeatWeekly) {
    // A weekly booking has two quite different meanings of "cancel", and
    // guessing the wrong one either strands twelve weeks or wipes them.
    const choice = await choiceDialog({
      title: "Cancel which?",
      message: `${when} repeats every week.`,
      options: [
        { value: "one", label: "Just this week" },
        { value: "series", label: "This and all future weeks", tone: "danger" }
      ]
    });
    if (!choice) return;
    scope = choice as "one" | "series";
  } else {
    const agreed = await confirmDialog({
      title: "Cancel this lesson?",
      message: `${when}. You can book another time afterwards.`,
      confirmLabel: "Cancel lesson",
      cancelLabel: "Keep it",
      tone: "danger"
    });
    if (!agreed) return;
  }

  try {
    const result = await api.post<{ ok: boolean; requested?: boolean }>("/api/cancel", {
      lessonId: lesson.lessonId,
      occStart: lesson.occStart,
      scope
    });
    toast(result.requested
      ? "Sent to your coach. They'll be in touch."
      : scope === "series" ? "Weekly booking ended." : "Cancelled.", "success");
    await refresh();
    await Promise.all([loadSlots(), loadMonth(visibleMonth)]);
  } catch (error) {
    toast(error instanceof Error ? error.message : "Could not cancel.", "error");
  }
}

/** One timer for every countdown on the page, rather than one each. */
function startCountdowns(): void {
  window.clearInterval(countdownTimer);
  const tick = () => {
    const nodes = document.querySelectorAll<HTMLElement>(".countdown[data-until]");
    if (nodes.length === 0) { window.clearInterval(countdownTimer); return; }
    let expired = false;
    for (const node of nodes) {
      const remaining = new Date(node.dataset.until!).getTime() - Date.now();
      if (remaining <= 0) { expired = true; continue; }
      node.textContent = `${countdown(remaining)} left`;
    }
    // Once a grace period lapses the row's buttons are wrong; reload.
    if (expired) void refresh();
  };
  tick();
  countdownTimer = window.setInterval(tick, 1000);
}

$("saveContact").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("saveContact");
  button.disabled = true;
  try {
    const result = await api.post<{ phoneLabel: string }>("/api/contact", {
      phone: $<HTMLInputElement>("phone").value.trim(),
      channels: pickedChannels("channelChips")
    });
    notice($("contactNotice"),
      result.phoneLabel ? `Saved. Your coach will reach you on ${result.phoneLabel}.` : "Saved.",
      "ok");
    await refresh();
  } catch (error) {
    notice($("contactNotice"),
      error instanceof Error ? error.message : "Could not save.", "error");
  } finally {
    button.disabled = false;
  }
});

/* ---------- my stats ---------- */

function renderStats(): void {
  const host = $("statsHost");
  clear(host);
  if (!me) return;

  const grid = el("div", "stat-grid");
  grid.append(
    stat(String(me.stats.count), "Lessons taken"),
    stat(formatHours(me.stats.minutes), "Total time"),
    stat(String(me.upcoming.length), "Upcoming"),
    stat(String(me.stats.cancellations), "Cancellations")
  );
  host.append(el("p", "sub", `Season ${me.season.label}`), grid);

  host.append(el("h3", undefined, "Lessons per month"));
  const chart = el("div");
  host.append(chart);
  barChart(chart, me.stats.byMonth);

  const types = Object.entries(me.stats.byType);
  if (types.length > 0) {
    host.append(el("h3", undefined, "By type"));
    const list = el("div");
    for (const [type, count] of types) {
      const row = el("div", "row");
      row.append(el("div", "grow", lessonSpec(type).label), el("strong", undefined, String(count)));
      list.append(row);
    }
    host.append(list);
  }
}

function stat(value: string, label: string): HTMLElement {
  const node = el("div", "stat");
  node.append(el("div", "value", value), el("div", "label", label));
  return node;
}

function notice(host: HTMLElement, message: string, kind: "info" | "warn" | "error" | "ok"): void {
  host.className = `notice ${kind}`;
  host.textContent = message;
  show(host, true);
}
