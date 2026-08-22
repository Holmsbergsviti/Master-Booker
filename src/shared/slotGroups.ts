/* =====================================================================
   Grouping slots for display.

   A flat list of twenty times is hard to read on a phone, where only a
   few fit on screen at once. Splitting them by time of day gives a
   student somewhere to look.

   Chronological within each section, deliberately. Slots that close a
   gap in the coach's day are marked rather than moved to the front:
   sorting them up scrambles the running order — 16:45, 17:30, 16:00 —
   and a list you cannot scan is worse than one you have to read twice.
   ===================================================================== */

import type { Slot } from "./types.js";
import { SLOT_SECTIONS } from "./config.js";
import { timeToMinutes } from "./time.js";

export interface SlotSection {
  id: string;
  label: string;
  slots: Slot[];
}

export function groupSlots(slots: readonly Slot[]): SlotSection[] {
  const buckets = new Map<string, Slot[]>();

  for (const slot of slots) {
    const minutes = timeToMinutes(slot.label);
    // The first section whose boundary the slot falls before. The last
    // entry runs to midnight, so there is always a match.
    const section = SLOT_SECTIONS.find(s => minutes < s.untilMinutes) ?? SLOT_SECTIONS[SLOT_SECTIONS.length - 1]!;
    const bucket = buckets.get(section.id);
    if (bucket) bucket.push(slot);
    else buckets.set(section.id, [slot]);
  }

  return SLOT_SECTIONS
    .map(section => ({
      id: section.id,
      label: section.label,
      slots: (buckets.get(section.id) ?? []).sort((a, b) => a.label.localeCompare(b.label))
    }))
    .filter(section => section.slots.length > 0);
}
