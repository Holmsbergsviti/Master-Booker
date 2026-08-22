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
    await refresh();
    showSignedIn();
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
      displayName: session.displayName
    });
    await refresh();
    showSignedIn();
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

/* ---------- booking ---------- */

const dateInput = $<HTMLInputElement>("bookDate");
const typeSelect = $<HTMLSelectElement>("bookType");

dateInput.addEventListener("change", loadSlots);
typeSelect.addEventListener("change", loadSlots);

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
      flexible: $<HTMLInputElement>("flexible").checked
    });
    toast(`Booked for ${result.label} on ${formatDayKeyLong(currentSlots.date)}.`, "success");
    selected = null;
    await refresh();
    await loadSlots();
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
  const date = dateInput.value;
  selected = null;
  if (!date) return;

  const host = $("slotHost");
  clear(host);
  host.append(el("p", "empty", "Loading…"));
  show($("confirmPanel"), false);

  try {
    currentSlots = await api.get<SlotsResponse>(
      `/api/slots?date=${encodeURIComponent(date)}&lessonType=${encodeURIComponent(typeSelect.value)}`
    );
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

  if (!data.window) {
    host.append(el("p", "empty", "The coach isn't teaching that day."));
    return;
  }

  // Derived data can drift when a rebuild fails. Say so rather than
  // quietly selling a slot that may already be taken.
  if (data.stale) {
    notice(noticeHost,
      "These times were last checked a while ago — your booking will still be verified when you confirm.",
      "warn");
  }

  if (data.slots.length === 0) {
    host.append(el("p", "empty",
      "Nothing free that day. Try another date — bookings close 24 hours before the lesson."));
    return;
  }

  // Slots that close an existing gap come first: taking one is the most
  // useful thing a client can do, and it keeps the coach's day packed.
  const ordered = [...data.slots].sort((a, b) =>
    Number(b.closesGap) - Number(a.closesGap) || a.label.localeCompare(b.label));

  const grid = el("div", "slot-grid");
  for (const slot of ordered) {
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

  if (ordered.some(s => s.closesGap)) {
    const legend = el("p", "slot-legend");
    legend.append(el("span", "dot"), document.createTextNode("Closes a gap in the coach's day"));
    host.append(legend);
  }

  if (selected) renderConfirm();
}

function renderConfirm(): void {
  if (!selected || !currentSlots) return;
  show($("confirmPanel"), true);

  const spec = lessonSpec(currentSlots.lessonType);
  $("confirmHeading").textContent =
    `${spec.label}, ${selected.label} on ${formatDayKeyLong(currentSlots.date)} (${spec.mins} min)`;

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

  // Only offer the types this client can actually book.
  if (typeSelect.options.length === 0) {
    for (const [value, spec] of Object.entries(LESSON_TYPES)) {
      if (!spec.bookable) continue;
      const option = el("option", undefined, `${spec.label} · ${spec.mins} min`);
      option.value = value;
      typeSelect.append(option);
    }
    typeSelect.value = me.client.defaultLessonType;
  }
  if (!dateInput.value) {
    // Not today. Bookings close 24 hours ahead, so every slot today is
    // already past its cutoff, and the index does not reach back before
    // the season starts. Opening on a date that cannot be booked greets
    // a new client with an error they did nothing to cause.
    const range = indexRange(new Date());
    const tomorrow = addDayKey(dayKey(new Date()), 1);
    const earliest = tomorrow > range.from ? tomorrow : range.from;

    dateInput.min = earliest;
    dateInput.max = range.to;
    dateInput.value = earliest;
    await loadSlots();
  }

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
        `${lessonSpec(lesson.lessonType).label}${lesson.flexible ? " · flexible" : ""} · ${relativeTime(new Date(), new Date(lesson.start))}`)
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
  const question = isRequest
    ? `Ask the coach to cancel ${lesson.label} on ${formatDayKeyLong(lesson.date)}?`
    : `Cancel ${lesson.label} on ${formatDayKeyLong(lesson.date)}?`;
  if (!window.confirm(question)) return;

  try {
    const result = await api.post<{ ok: boolean; requested?: boolean }>("/api/cancel", {
      lessonId: lesson.lessonId
    });
    toast(result.requested
      ? "Sent to your coach. They'll be in touch."
      : "Cancelled.", "success");
    await refresh();
    await loadSlots();
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
