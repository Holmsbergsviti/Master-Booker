/* =====================================================================
   The coach panel.

   The validator constrains clients, not the coach. Everything here can
   move, reassign or cancel anything, and the rules get out of the way —
   they surface as warnings. The one thing the panel will not do quietly
   is change a client's lesson without telling them.
   ===================================================================== */

import "../style.css";
import type { AvailabilityDoc, ClientDoc, Occurrence, RequestDoc } from "../shared/types.js";
import type { CompactPlan } from "../shared/compact.js";
import type { CoachStats } from "../shared/stats.js";
import { api, ApiError } from "../lib/api.js";
import { coachSession, setCoachSession, useSession } from "../lib/session.js";
import { $, barChart, clear, el, show, toast, wireTheme } from "../lib/ui.js";
import { confirmDialog, promptDialog } from "../lib/dialog.js";
import { LESSON_TYPES, lessonSpec } from "../shared/config.js";
import { addDayKey, dayKey, formatDayKeyLong, formatTime } from "../shared/time.js";
import { formatHours } from "../shared/stats.js";
import { CHANNELS, formatPhone } from "../shared/contact.js";

/* ---------- responses ---------- */

interface DayLesson extends Occurrence {
  label: string;
  minutes: number;
  clientName: string | null;
  booked: boolean;
}

interface DayResponse {
  date: string;
  window: { start: string; end: string; gapBudget: number | null } | null;
  lessons: DayLesson[];
  dead: number;
  restCredited: number;
  budget: number;
  compact: CompactPlan;
  requests: Array<RequestDoc & { id: string; clientName: string | null }>;
  stale: boolean;
  rebuiltAt: string | null;
}

interface ConfigResponse {
  availability: AvailabilityDoc[];
  clients: ClientDoc[];
}

interface StatsResponse {
  season: { label: string; startYear: number };
  seasons: Array<{ label: string; startYear: number }>;
  stats: CoachStats;
  clients: ClientDoc[];
  unmappedTitles: Array<{ title: string; count: number }>;
}

/* ---------- state ---------- */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

let day: DayResponse | null = null;
let config: ConfigResponse | null = null;
let stats: StatsResponse | null = null;

/* ---------- boot ---------- */

useSession("coach");

wireTheme($("themeToggle"));
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
  if (!coachSession()) {
    showSignedOut();
    return;
  }
  try {
    await loadAll();
    showSignedIn();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      setCoachSession(null);
      showSignedOut();
      notice($("loginNotice"), "That session has expired. Enter the passcode again.", "warn");
      return;
    }
    toast(error instanceof Error ? error.message : "Could not load the panel.", "error");
  }
}

async function loadAll(): Promise<void> {
  $<HTMLInputElement>("dayDate").value ||= dayKey(new Date());
  await Promise.all([loadDay(), loadConfig(), loadOutbox()]);
}

function showSignedIn(): void {
  show($("loginView"), false);
  show($("appView"), true);
  show($("signOut"), true);
  $("who").textContent = "Coach";
}

function showSignedOut(): void {
  show($("loginView"), true);
  show($("appView"), false);
  show($("signOut"), false);
  $("who").textContent = "";
}

$("signIn").addEventListener("click", async () => {
  const passcode = $<HTMLInputElement>("passcode").value;
  if (!passcode) return;

  const button = $<HTMLButtonElement>("signIn");
  button.disabled = true;
  try {
    const result = await api.signIn<{ token: string }>("/api/coach/signin", { passcode });
    setCoachSession(result.token);
    $<HTMLInputElement>("passcode").value = "";
    await loadAll();
    showSignedIn();
  } catch (error) {
    notice($("loginNotice"),
      error instanceof Error ? error.message : "Could not sign in.", "error");
  } finally {
    button.disabled = false;
  }
});

$("signOut").addEventListener("click", () => {
  setCoachSession(null);
  showSignedOut();
});

for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  tab.addEventListener("click", async () => {
    for (const other of document.querySelectorAll(".tab")) other.classList.remove("active");
    tab.classList.add("active");
    const view = tab.dataset.view;
    show($("dayView"), view === "day");
    show($("availabilityView"), view === "availability");
    show($("clientsView"), view === "clients");
    show($("requestsView"), view === "requests");
    show($("outboxView"), view === "outbox");
    show($("statsView"), view === "stats");
    if (view === "stats" && !stats) await loadStats();
    if (view === "outbox") await loadOutbox();
  });
}

/* ---------- day view ---------- */

const dayDate = $<HTMLInputElement>("dayDate");
dayDate.addEventListener("change", loadDay);
$("dayPrev").addEventListener("click", () => { dayDate.value = addDayKey(dayDate.value, -1); void loadDay(); });
$("dayNext").addEventListener("click", () => { dayDate.value = addDayKey(dayDate.value, 1); void loadDay(); });
$("dayToday").addEventListener("click", () => { dayDate.value = dayKey(new Date()); void loadDay(); });

async function loadDay(): Promise<void> {
  const date = dayDate.value || dayKey(new Date());
  day = await api.get<DayResponse>(`/api/coach/day?date=${encodeURIComponent(date)}`);
  renderDay();
  renderRequests();
}

function renderDay(): void {
  const host = $("dayHost");
  const noticeHost = $("dayNotice");
  const statsHost = $("dayStats");
  clear(host); clear(statsHost);
  show(noticeHost, false);
  if (!day) return;

  if (day.stale) {
    notice(noticeHost,
      `This day was last rebuilt ${day.rebuiltAt ? new Date(day.rebuiltAt).toLocaleString() : "never"}. It may be out of date.`,
      "warn");
  }

  statsHost.append(
    stat(String(day.lessons.length), "Lessons"),
    stat(formatHours(day.lessons.reduce((s, l) => s + l.minutes, 0)), "Taught"),
    stat(`${day.dead}m`, "Idle time"),
    stat(day.window ? `${day.budget}m` : "—", "Gap budget")
  );

  if (!day.window) {
    host.append(el("p", "empty", "No availability set for this day."));
  } else {
    host.append(el("p", "sub",
      `${formatDayKeyLong(day.date)} · ${day.window.start}–${day.window.end}` +
      (day.restCredited ? ` · ${day.restCredited}m earned rest` : "")));
  }

  if (day.lessons.length === 0) {
    host.append(el("p", "empty", "Nothing booked."));
  }

  for (const lesson of day.lessons) {
    const row = el("div", "row");
    const left = el("div", "grow");
    left.append(
      el("div", "time", `${lesson.label} · ${lesson.clientName ?? lesson.title ?? "Untitled"}`),
      el("div", "sub",
        `${lessonSpec(lesson.lessonType).label} · ${lesson.minutes} min` +
        (lesson.flexible ? " · flexible" : "") +
        (lesson.booked ? "" : " · entered by hand"))
    );
    row.append(left);

    const move = el("button", "btn ghost small", "Move");
    move.addEventListener("click", () => moveLesson(lesson));
    const drop = el("button", "btn ghost small", "Cancel");
    drop.addEventListener("click", () => cancelLesson(lesson));
    row.append(move, drop);
    host.append(row);
  }

  renderCompact();
}

async function moveLesson(lesson: DayLesson): Promise<void> {
  const who = lesson.clientName ?? lesson.title ?? "this lesson";
  const answer = await promptDialog({
    title: `Move ${who}`,
    message: `Currently ${lesson.label}. All times are Belgrade.`,
    label: "New start time",
    // A real time input: phones give it their own wheel picker, and it
    // cannot produce something that is not a time.
    inputType: "time",
    step: "900",
    value: lesson.label,
    confirmLabel: "Move"
  });
  if (!answer || !/^\d{1,2}:\d{2}$/.test(answer.trim())) return;

  const [h, m] = answer.trim().split(":").map(Number);
  const start = new Date(lesson.start);
  // Build the new instant from the day key and the wall clock, never by
  // poking at a Date's local fields — the browser may not be in Belgrade.
  const { dayTimeToUtc } = await import("../shared/time.js");
  const target = dayTimeToUtc(dayKey(start), `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);

  if (lesson.booked) {
    const agreed = await confirmDialog({
      title: "Move a booked lesson?",
      message: `${lesson.clientName ?? "The client"} gets a fresh 12-hour cancellation window, ` +
               `and appears under "To tell" for you to message.`,
      confirmLabel: "Move it"
    });
    if (!agreed) return;
  }

  try {
    const result = await api.post<{ warnings: string[] }>("/api/coach/action", {
      action: "move", lessonId: lesson.lessonId, start: target.toISOString()
    });
    toast("Moved.", "success");
    for (const warning of result.warnings ?? []) toast(warning, "info");
    await Promise.all([loadDay(), loadOutbox()]);
  } catch (error) {
    toast(error instanceof Error ? error.message : "Could not move it.", "error");
  }
}

async function cancelLesson(lesson: DayLesson): Promise<void> {
  const agreed = await confirmDialog({
    title: `Cancel ${lesson.label}?`,
    message: `${lesson.clientName ?? lesson.title ?? "This lesson"} will come off the calendar.` +
             (lesson.booked ? ` They'll appear under "To tell" for you to message.` : ""),
    confirmLabel: "Cancel lesson",
    cancelLabel: "Keep it",
    tone: "danger"
  });
  if (!agreed) return;
  try {
    await api.post("/api/coach/action", { action: "cancel", lessonId: lesson.lessonId });
    toast("Cancelled.", "success");
    await Promise.all([loadDay(), loadOutbox()]);
  } catch (error) {
    toast(error instanceof Error ? error.message : "Could not cancel.", "error");
  }
}

/** The preview always comes first. Applying it messages real people. */
function renderCompact(): void {
  const host = $("compactHost");
  clear(host);
  if (!day?.window || day.compact.moves.length === 0) {
    if (day?.window && day.dead > 0) {
      host.append(el("p", "empty",
        "Nothing can be compacted — the gaps are around clients who didn't agree to shift."));
    }
    return;
  }

  const panel = el("div", "notice info");
  panel.append(el("strong", undefined,
    `Compact day: saves ${day.compact.saved} minutes of idle time`));
  for (const move of day.compact.moves) {
    panel.append(el("div", undefined, `${move.title ?? "Client"}: ${move.fromLabel} → ${move.toLabel}`));
  }
  host.append(panel);

  const button = el("button", "btn primary", "Apply");
  button.addEventListener("click", async () => {
    const count = day!.compact.moves.length;
    const agreed = await confirmDialog({
      title: `Move ${count} client${count === 1 ? "" : "s"}?`,
      message: `This closes ${day!.compact.saved} minutes of idle time. ` +
               `Everyone moved appears under "To tell" for you to message.`,
      confirmLabel: "Move them"
    });
    if (!agreed) return;
    button.disabled = true;
    try {
      await api.post("/api/coach/action", { action: "compact-day", date: day!.date, apply: true });
      toast("Day compacted — now tell them, on the To tell tab.", "success");
      await Promise.all([loadDay(), loadOutbox()]);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not compact.", "error");
    } finally {
      button.disabled = false;
    }
  });
  host.append(button);
}

/* ---------- availability ---------- */

const availKind = $<HTMLSelectElement>("availKind");
availKind.addEventListener("change", () => {
  show($("availWeekdayField"), availKind.value === "weekly");
  show($("availDateField"), availKind.value === "date");
});

for (let i = 0; i < 7; i++) {
  const option = el("option", undefined, WEEKDAYS[i]!);
  option.value = String(i);
  $("availWeekday").append(option);
}
$<HTMLSelectElement>("availWeekday").value = "1";

$("availSave").addEventListener("click", async () => {
  const kind = availKind.value;
  const doc: Partial<AvailabilityDoc> = {
    start: $<HTMLInputElement>("availStart").value,
    end: $<HTMLInputElement>("availEnd").value,
    gapBudget: $<HTMLInputElement>("availBudget").value
      ? Number($<HTMLInputElement>("availBudget").value) : null,
    closed: $<HTMLInputElement>("availClosed").checked
  };
  if (kind === "weekly") {
    doc.weekday = Number($<HTMLSelectElement>("availWeekday").value);
    doc.validFrom = dayKey(new Date());
  } else {
    doc.date = $<HTMLInputElement>("availDate").value;
    if (!doc.date) { toast("Pick a date.", "error"); return; }
  }

  try {
    await api.post("/api/coach/action", { action: "save-availability", doc });
    toast("Saved.", "success");
    await loadConfig();
    await loadDay();
  } catch (error) {
    toast(error instanceof Error ? error.message : "Could not save.", "error");
  }
});

async function loadConfig(): Promise<void> {
  config = await api.get<ConfigResponse>("/api/coach/config");
  renderAvailability();
  renderClients();
}

function renderAvailability(): void {
  const host = $("availHost");
  clear(host);
  if (!config) return;
  if (config.availability.length === 0) {
    host.append(el("p", "empty", "No windows yet — nothing can be booked until there is one."));
    return;
  }

  // Not named `window`: shadowing the global inside a handler is a trap
  // waiting to be sprung.
  for (const slot of config.availability) {
    const row = el("div", "row");
    const label = slot.date
      ? formatDayKeyLong(slot.date)
      : `Every ${WEEKDAYS[slot.weekday ?? 0]}`;
    const left = el("div", "grow");
    left.append(
      el("div", "time", slot.closed ? `${label} — closed` : `${label} · ${slot.start}–${slot.end}`),
      el("div", "sub", slot.gapBudget === null || slot.gapBudget === undefined
        ? "Gap budget from lead time"
        : `Gap budget ${slot.gapBudget} min`)
    );
    row.append(left);

    const remove = el("button", "btn ghost small", "Remove");
    remove.addEventListener("click", async () => {
      if (!slot.id) return;
      const agreed = await confirmDialog({
        title: "Remove this window?",
        message: `${label}. Students will not be able to book then.`,
        confirmLabel: "Remove",
        tone: "danger"
      });
      if (!agreed) return;
      await api.post("/api/coach/action", { action: "delete-availability", id: slot.id });
      await loadConfig();
      await loadDay();
    });
    row.append(remove);
    host.append(row);
  }
}

/* ---------- clients ---------- */

for (const [value, spec] of Object.entries(LESSON_TYPES)) {
  if (!spec.bookable) continue;
  const option = el("option", undefined, `${spec.label} · ${spec.mins} min`);
  option.value = value;
  $("clientType").append(option);
}

for (const channel of CHANNELS) {
  const button = el("button", "btn ghost small", channel.label);
  button.type = "button";
  button.dataset.channel = channel.value;
  button.addEventListener("click", () => {
    button.classList.toggle("primary");
    button.classList.toggle("ghost");
  });
  $("clientChannels").append(button);
}

function pickedChannels(hostId: string): string[] {
  return [...document.querySelectorAll<HTMLElement>(`#${hostId} [data-channel]`)]
    .filter(node => node.classList.contains("primary"))
    .map(node => node.dataset.channel!);
}

$("clientSave").addEventListener("click", async () => {
  const people = [
    { name: $<HTMLInputElement>("p1name").value.trim() },
    { name: $<HTMLInputElement>("p2name").value.trim() }
  ].filter(p => p.name);

  const client = {
    displayName: $<HTMLInputElement>("clientName").value.trim(),
    people,
    defaultLessonType: $<HTMLSelectElement>("clientType").value,
    phone: $<HTMLInputElement>("clientPhone").value.trim(),
    channels: pickedChannels("clientChannels"),
    active: true
  };
  if (!client.displayName || people.length === 0) {
    toast("A display name and at least one person, please.", "error");
    return;
  }

  try {
    await api.post("/api/coach/action", { action: "save-client", client });
    toast("Client saved.", "success");
    for (const id of ["clientName", "p1name", "p2name", "clientPhone"]) {
      $<HTMLInputElement>(id).value = "";
    }
    await loadConfig();
  } catch (error) {
    toast(error instanceof Error ? error.message : "Could not save.", "error");
  }
});

function renderClients(): void {
  const host = $("clientsHost");
  clear(host);
  if (!config) return;
  if (config.clients.length === 0) {
    host.append(el("p", "empty", "No clients yet."));
    return;
  }

  for (const client of config.clients) {
    const row = el("div", "row");
    const left = el("div", "grow");
    left.append(
      el("div", "time", client.displayName),
      el("div", "sub",
        `${(client.people ?? []).map(p => p.name).join(" & ")} · ${lessonSpec(client.defaultLessonType).label}` +
        (client.phone
          ? ` · ${formatPhone(client.phone)}${(client.channels ?? []).length ? ` (${(client.channels ?? []).join(", ")})` : " · no app picked"}`
          : " · no phone, cannot sign in or be told about changes"))
    );
    row.append(left);
    if (!client.active) row.append(el("span", "pill", "Inactive"));

    const toggle = el("button", "btn ghost small", client.active ? "Deactivate" : "Reactivate");
    toggle.addEventListener("click", async () => {
      await api.post("/api/coach/action", {
        action: "save-client",
        id: client.id,
        client: { ...client, active: !client.active }
      });
      await loadConfig();
    });
    row.append(toggle);
    host.append(row);
  }
}

/* ---------- requests ---------- */

function renderRequests(): void {
  const host = $("requestsHost");
  const badge = $("requestCount");
  clear(host);
  const requests = day?.requests ?? [];

  show(badge, requests.length > 0);
  badge.textContent = String(requests.length);

  if (requests.length === 0) {
    host.append(el("p", "empty", "Nothing waiting."));
    return;
  }

  for (const request of requests) {
    const row = el("div", "row");
    const left = el("div", "grow");
    const when = request.start ? `${formatTime(new Date(request.start))} on ${formatDayKeyLong(dayKey(new Date(request.start)))}` : "";
    left.append(
      el("div", "time", `${request.clientName ?? "Client"} — ${request.kind === "cancel" ? "late cancellation" : "booking"}`),
      el("div", "sub", `${when}${request.message ? ` · "${request.message}"` : ""}`)
    );
    row.append(left);

    const approve = el("button", "btn primary small", "Approve");
    approve.addEventListener("click", () => resolve(request.id, true));
    const decline = el("button", "btn ghost small", "Decline");
    decline.addEventListener("click", () => resolve(request.id, false));
    row.append(approve, decline);
    host.append(row);
  }
}

async function resolve(requestId: string, approve: boolean): Promise<void> {
  try {
    await api.post("/api/coach/action", { action: "resolve-request", requestId, approve });
    toast(approve ? "Approved." : "Declined.", "success");
    await loadDay();
  } catch (error) {
    toast(error instanceof Error ? error.message : "Could not resolve.", "error");
  }
}

/* ---------- outbox ---------- */

interface OutboxItem {
  id: string;
  kind: string;
  clientName: string;
  summary: string;
  phone: string | null;
  phoneLabel: string;
  links: Array<{ channel: string; label: string; href: string }>;
  reachable: boolean;
  createdAt: string;
}

let outbox: { items: OutboxItem[]; unreachable: number } | null = null;

async function loadOutbox(): Promise<void> {
  outbox = await api.get<{ items: OutboxItem[]; unreachable: number }>("/api/coach/outbox");
  renderOutbox();
}

function renderOutbox(): void {
  const host = $("outboxHost");
  const noticeHost = $("outboxNotice");
  const badge = $("outboxCount");
  clear(host);
  show(noticeHost, false);
  if (!outbox) return;

  show(badge, outbox.items.length > 0);
  badge.textContent = String(outbox.items.length);

  if (outbox.items.length === 0) {
    host.append(el("p", "empty", "Nobody is waiting to hear from you."));
    return;
  }

  // A client with no number is the case that must be loud, not the one
  // that quietly drops off the list.
  if (outbox.unreachable > 0) {
    notice(noticeHost,
      `${outbox.unreachable} of these has no phone number on file — add one on the Clients tab, or contact them another way.`,
      "warn");
  }

  for (const item of outbox.items) {
    const row = el("div", "row");
    const left = el("div", "grow");
    left.append(
      el("div", "time", item.clientName),
      el("div", "sub", item.summary)
    );
    row.append(left);

    if (item.reachable) {
      for (const link of item.links) {
        const anchor = el("a", "btn ghost small", link.label);
        anchor.href = link.href;
        anchor.target = "_blank";
        anchor.rel = "noopener";
        // Opening the app is not proof the message was sent, so the
        // coach still confirms explicitly below.
        row.append(anchor);
      }
    } else {
      row.append(el("span", "pill warn", "No number"));
    }

    const done = el("button", "btn primary small", "Told them");
    done.addEventListener("click", async () => {
      done.disabled = true;
      try {
        await api.post("/api/coach/action", {
          action: "mark-notified", id: item.id,
          via: item.links[0]?.channel ?? null
        });
        await loadOutbox();
      } catch (error) {
        toast(error instanceof Error ? error.message : "Could not mark it.", "error");
        done.disabled = false;
      }
    });
    row.append(done);
    host.append(row);
  }
}

/* ---------- stats ---------- */

const seasonSelect = $<HTMLSelectElement>("statsSeason");
seasonSelect.addEventListener("change", () => void loadStats(Number(seasonSelect.value)));

async function loadStats(season?: number): Promise<void> {
  stats = await api.get<StatsResponse>(`/api/coach/stats${season ? `?season=${season}` : ""}`);

  if (seasonSelect.options.length === 0) {
    for (const option of stats.seasons) {
      const node = el("option", undefined, option.label);
      node.value = String(option.startYear);
      seasonSelect.append(node);
    }
  }
  seasonSelect.value = String(stats.season.startYear);
  renderStats();
}

function renderStats(): void {
  const host = $("statsHost");
  clear(host);
  if (!stats) return;
  const s = stats.stats;

  const grid = el("div", "stat-grid");
  grid.append(
    stat(String(s.total.count), "Lessons"),
    stat(formatHours(s.total.minutes), "Hours taught"),
    stat(`${Math.round(s.utilisation.ratio * 100)}%`, "Window utilisation"),
    stat(formatHours(s.utilisation.idleMinutes), "Idle time absorbed"),
    stat(String(s.cancellations.total), "Cancellations")
  );
  host.append(grid);

  // The metric that closes the loop on the original problem: high
  // utilisation with near-zero idle time means the gap budget can be
  // loosened; idle hours accumulating means tighten it.
  const meter = el("div", "meter");
  const fill = el("div", "fill");
  fill.style.width = `${Math.min(100, Math.round(s.utilisation.ratio * 100))}%`;
  meter.append(fill);
  host.append(
    el("p", "sub", `${formatHours(s.utilisation.bookedMinutes)} booked of ${formatHours(s.utilisation.offeredMinutes)} offered`),
    meter
  );

  host.append(el("h3", undefined, "Lessons per month"));
  const chart = el("div");
  host.append(chart);
  barChart(chart, s.byMonth);

  host.append(el("h3", undefined, "Per client"));
  const wrap = el("div", "table-scroll");
  const table = el("table");
  const head = el("tr");
  head.append(el("th", undefined, "Client"), thNum("Lessons"), thNum("Hours"), thNum("Cancelled"));
  table.append(head);
  for (const client of s.byClient) {
    const row = el("tr");
    row.append(
      el("td", undefined, client.label),
      tdNum(String(client.count)),
      tdNum(formatHours(client.minutes)),
      tdNum(String(client.clientId ? s.cancellations.byClient[client.clientId] ?? 0 : 0))
    );
    table.append(row);
  }
  wrap.append(table);
  host.append(wrap);

  renderBackfill(host);
}

/** Lessons entered by hand before launch carry no clientId, but their
 *  titles are already clean names. Tapping each to a client recovers
 *  them in minutes. */
function renderBackfill(host: HTMLElement): void {
  if (!stats || stats.unmappedTitles.length === 0) return;

  host.append(el("h3", undefined, "Unmatched names"));
  host.append(el("p", "sub",
    "These lessons have no client attached, so they don't count toward anyone's totals."));

  for (const entry of stats.unmappedTitles) {
    const row = el("div", "row");
    const left = el("div", "grow");
    left.append(
      el("div", "time", entry.title),
      el("div", "sub", `${entry.count} lesson${entry.count === 1 ? "" : "s"}`)
    );
    row.append(left);

    const picker = el("select");
    picker.style.width = "auto";
    picker.append(el("option", undefined, "Match to…"));
    for (const client of stats.clients) {
      const option = el("option", undefined, client.displayName);
      option.value = client.id;
      picker.append(option);
    }
    picker.addEventListener("change", async () => {
      if (!picker.value) return;
      try {
        const result = await api.post<{ lessons: number }>("/api/coach/action", {
          action: "map-title", title: entry.title, clientId: picker.value
        });
        toast(`Matched ${result.lessons} lesson(s).`, "success");
        await loadStats(Number(seasonSelect.value));
      } catch (error) {
        toast(error instanceof Error ? error.message : "Could not match.", "error");
      }
    });
    row.append(picker);
    host.append(row);
  }
}

/* ---------- bits ---------- */

function stat(value: string, label: string): HTMLElement {
  const node = el("div", "stat");
  node.append(el("div", "value", value), el("div", "label", label));
  return node;
}

function thNum(text: string): HTMLElement {
  const node = el("th", "num", text);
  return node;
}

function tdNum(text: string): HTMLElement {
  return el("td", "num", text);
}

function notice(host: HTMLElement, message: string, kind: "info" | "warn" | "error" | "ok"): void {
  host.className = `notice ${kind}`;
  host.textContent = message;
  show(host, true);
}
