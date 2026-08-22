import { describe, expect, it } from "vitest";
import type { Occurrence } from "../src/shared/types.js";
import { compactDay } from "../src/shared/compact.js";
import { dayTimeToUtc } from "../src/shared/time.js";
import { lessonSpec } from "../src/shared/config.js";

const DATE = "2026-09-07";

function booked(time: string, opts: { flexible?: boolean; type?: string; id?: string } = {}): Occurrence {
  const type = opts.type ?? "class";
  const start = dayTimeToUtc(DATE, time);
  return {
    lessonId: opts.id ?? `at-${time}`,
    start: start.toISOString(),
    end: new Date(start.getTime() + lessonSpec(type).mins * 60_000).toISOString(),
    occStart: start.toISOString(),
    lessonType: type,
    coach: ["Vlad"],
    title: `Client ${time}`,
    clientId: `c-${time}`,
    flexible: !!opts.flexible
  };
}

const plan = (lessons: Occurrence[]) =>
  compactDay({ date: DATE, windowStart: "16:00", lessons });

describe("compact day", () => {
  it("does nothing to a day with no gaps", () => {
    const result = plan([booked("18:00", { flexible: true }), booked("18:45", { flexible: true })]);
    expect(result.moves).toEqual([]);
    expect(result.saved).toBe(0);
  });

  it("never moves a client who did not agree to be shifted", () => {
    const result = plan([booked("16:00"), booked("19:00")]);
    expect(result.moves).toEqual([]);
    expect(result.deadBefore).toBe(135);
  });

  it("slides a flexible client up against the lesson in front", () => {
    const result = plan([booked("16:00"), booked("16:45", { flexible: true })]);
    expect(result.moves).toEqual([]); // already adjacent

    const gapped = plan([booked("16:00"), booked("17:15", { flexible: true })]);
    expect(gapped.moves).toHaveLength(1);
    expect(gapped.moves[0]!.toLabel).toBe("16:45");
    expect(gapped.saved).toBe(30);
    expect(gapped.deadAfter).toBe(0);
  });

  it("never moves anyone further than the hour they agreed to", () => {
    // A two-hour hole: the client consented to one hour, not two.
    const result = plan([booked("16:00"), booked("19:00", { flexible: true })]);
    expect(result.moves).toHaveLength(1);
    expect(result.moves[0]!.toLabel).toBe("18:00");
    expect(result.deadAfter).toBeGreaterThan(0);
  });

  it("packs several flexible clients in order without overlapping them", () => {
    const result = plan([
      booked("16:00"),
      booked("17:30", { flexible: true }),
      booked("19:00", { flexible: true })
    ]);
    // The last one only agreed to an hour, so 18:00 is as far as it goes.
    expect(result.moves.map(m => m.toLabel)).toEqual(["16:45", "18:00"]);
    expect(result.deadAfter).toBe(30);
  });

  it("keeps a fixed lesson exactly where it is and works around it", () => {
    const result = plan([
      booked("16:00"),
      booked("18:00"),                     // fixed, must not move
      booked("19:30", { flexible: true })
    ]);
    expect(result.moves).toHaveLength(1);
    expect(result.moves[0]!.toLabel).toBe("18:45");
    // The 16:45-18:00 hole stays: nobody in it agreed to move.
    expect(result.deadAfter).toBe(75);
  });

  it("leaves the first lesson of the day alone", () => {
    // Idle time before the evening starts is not dead time, so pulling
    // the opening lesson earlier closes nothing and just moves someone
    // who had no reason to be moved.
    expect(plan([booked("18:00", { flexible: true })]).moves).toEqual([]);
    expect(plan([booked("16:15", { flexible: true })]).moves).toEqual([]);
  });

  it("reports the instants, not only the labels, so the write is unambiguous", () => {
    const result = plan([booked("16:00"), booked("17:15", { flexible: true })]);
    expect(result.moves[0]!.to).toBe(dayTimeToUtc(DATE, "16:45").toISOString());
    expect(result.moves[0]!.from).toBe(dayTimeToUtc(DATE, "17:15").toISOString());
    expect(result.moves[0]!.clientId).toBe("c-17:15");
  });

  it("respects a Double's full length when packing behind it", () => {
    const result = plan([
      booked("16:00", { type: "double" }),
      booked("18:30", { flexible: true })
    ]);
    expect(result.moves[0]!.toLabel).toBe("17:30");
  });
});
