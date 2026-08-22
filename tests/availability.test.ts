import { describe, expect, it } from "vitest";
import type { AvailabilityDoc } from "../src/shared/types.js";
import { offeredMinutes, windowForDay } from "../src/shared/availability.js";

const weekly = (weekday: number, start: string, end: string, extra: Partial<AvailabilityDoc> = {}):
  AvailabilityDoc => ({ weekday, start, end, validFrom: "2026-09-01", ...extra });

describe("availability", () => {
  const docs: AvailabilityDoc[] = [
    weekly(1, "16:00", "21:00"),                       // Monday
    weekly(4, "17:00", "21:00"),                       // Thursday
    { date: "2026-09-10", start: "16:00", end: "19:00" }, // a shorter Thursday
    { date: "2026-09-14", start: "16:00", end: "21:00", closed: true } // a Monday off
  ];

  it("finds the weekly window for a day", () => {
    expect(windowForDay(docs, "2026-09-07")).toMatchObject({ start: "16:00", end: "21:00" });
    expect(windowForDay(docs, "2026-09-17")).toMatchObject({ start: "17:00", end: "21:00" });
  });

  it("returns nothing on a day with no pattern", () => {
    expect(windowForDay(docs, "2026-09-09")).toBeNull(); // Wednesday
  });

  it("lets a dated entry override the weekly pattern", () => {
    expect(windowForDay(docs, "2026-09-10")).toMatchObject({ start: "16:00", end: "19:00" });
  });

  it("lets a dated entry close a day the pattern would have opened", () => {
    expect(windowForDay(docs, "2026-09-14")).toBeNull();
  });

  it("ignores a pattern that has not started yet", () => {
    const future = [weekly(1, "16:00", "21:00", { validFrom: "2026-10-01" })];
    expect(windowForDay(future, "2026-09-07")).toBeNull();
    expect(windowForDay(future, "2026-10-05")).not.toBeNull();
  });

  it("ignores a pattern that has expired", () => {
    const expired = [weekly(1, "16:00", "21:00", { validUntil: "2026-09-30" })];
    expect(windowForDay(expired, "2026-09-07")).not.toBeNull();
    expect(windowForDay(expired, "2026-10-05")).toBeNull();
  });

  it("takes the newest pattern when two overlap", () => {
    const both = [
      weekly(1, "16:00", "21:00", { validFrom: "2026-09-01" }),
      weekly(1, "15:00", "20:00", { validFrom: "2026-10-01" })
    ];
    expect(windowForDay(both, "2026-09-07")).toMatchObject({ start: "16:00" });
    expect(windowForDay(both, "2026-10-05")).toMatchObject({ start: "15:00" });
  });

  it("refuses a window that ends before it starts rather than offering nonsense", () => {
    expect(windowForDay([{ date: "2026-09-07", start: "21:00", end: "16:00" }], "2026-09-07")).toBeNull();
  });

  it("carries a per-day gap budget override through", () => {
    const override = [{ date: "2026-09-07", start: "16:00", end: "21:00", gapBudget: 0 }];
    expect(windowForDay(override, "2026-09-07")?.gapBudget).toBe(0);
    // No override means "use the lead-time table", which is not the same
    // as a budget of zero.
    expect(windowForDay(docs, "2026-09-07")?.gapBudget).toBeNull();
  });

  it("adds up the hours offered across a run of days", () => {
    // Mon 7th (5h) + Thu 10th (3h, the dated override) + Mon 14th (closed)
    const minutes = offeredMinutes(docs, [
      "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10",
      "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14"
    ]);
    expect(minutes).toBe(300 + 180);
  });
});
