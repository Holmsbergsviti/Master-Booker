import { describe, expect, it } from "vitest";
import type { Slot } from "../src/shared/types.js";
import { groupSlots } from "../src/shared/slotGroups.js";

const slot = (label: string, closesGap = false): Slot =>
  ({ start: "", end: "", label, deadAfter: 0, closesGap });

describe("grouping slots by time of day", () => {
  it("splits into morning, day and evening", () => {
    const sections = groupSlots([slot("10:00"), slot("14:30"), slot("19:00")]);
    expect(sections.map(s => s.label)).toEqual(["Morning", "Day", "Evening"]);
  });

  it("does not render a section with nothing in it", () => {
    // A studio open 16:00-21:00 has no morning at all.
    const sections = groupSlots([slot("16:00"), slot("18:30")]);
    expect(sections.map(s => s.label)).toEqual(["Day", "Evening"]);
  });

  it("puts the boundaries where they belong", () => {
    expect(groupSlots([slot("11:59")])[0]!.label).toBe("Morning");
    expect(groupSlots([slot("12:00")])[0]!.label).toBe("Day");
    expect(groupSlots([slot("17:59")])[0]!.label).toBe("Day");
    expect(groupSlots([slot("18:00")])[0]!.label).toBe("Evening");
  });

  it("keeps each section in chronological order", () => {
    // Gap-closing slots are marked, never reordered: a list that runs
    // 16:45, 17:30, 16:00 cannot be scanned.
    const sections = groupSlots([
      slot("19:30"), slot("18:15", true), slot("20:00"), slot("18:00")
    ]);
    expect(sections[0]!.slots.map(s => s.label)).toEqual(["18:00", "18:15", "19:30", "20:00"]);
    expect(sections[0]!.slots.find(s => s.label === "18:15")!.closesGap).toBe(true);
  });

  it("returns nothing for a day with no slots", () => {
    expect(groupSlots([])).toEqual([]);
  });
});
