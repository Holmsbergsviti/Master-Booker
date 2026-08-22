/* =====================================================================
   Compact day.

   Slides flexible clients earlier to close gaps the evening has picked
   up. Only clients who ticked "can you shift me by an hour if needed?"
   are moved, and only within the hour they agreed to — a lesson silently
   moving further than that is the worst failure this system could
   produce.

   Pure on purpose: the coach sees the proposal before anything is
   written, because applying it notifies every client it touches.
   ===================================================================== */

import type { Occurrence } from "./types.js";
import { FLEXIBLE_SHIFT_MINUTES, SLOT_ALIGN_MINUTES } from "./config.js";
import { deadTime, type Interval } from "./slotEngine.js";
import { dayTimeToUtc, lessonMinutes, minutesOfDay, minutesToTime, timeToMinutes } from "./time.js";
import { lessonSpec } from "./config.js";

export interface Move {
  lessonId: string;
  clientId: string | null;
  title: string | null;
  durationMins: number;
  fromMin: number;
  toMin: number;
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
}

export interface CompactPlan {
  moves: Move[];
  deadBefore: number;
  deadAfter: number;
  /** Minutes of idle time the plan removes. */
  saved: number;
}

export interface CompactInput {
  date: string;
  windowStart: string;
  lessons: Occurrence[];
}

export function compactDay(input: CompactInput): CompactPlan {
  const windowStartMin = timeToMinutes(input.windowStart);

  const placed = input.lessons
    .map(occ => {
      const start = new Date(occ.start);
      const startMin = minutesOfDay(start);
      const duration = lessonMinutes(occ.start, occ.end);
      return {
        occ,
        startMin,
        duration,
        endMin: startMin + duration,
        flexible: !!occ.flexible,
        weight: lessonSpec(occ.lessonType).breakWeight
      };
    })
    .sort((a, b) => a.startMin - b.startMin);

  const before = deadTime(placed.map(toInterval));
  const moves: Move[] = [];

  // Earliest minute the next lesson may start. A fixed lesson pushes it
  // to its own end; a moved one to wherever it landed. Null until the
  // first lesson is placed.
  let cursor: number | null = null;

  for (const lesson of placed) {
    // The first lesson of the day never moves. Dead time is measured
    // from where the evening starts, so pulling the opening lesson
    // toward the window start closes no gap — it just drags everyone an
    // hour earlier for nothing, which is not what "compact" means.
    if (cursor === null || !lesson.flexible) {
      cursor = Math.max(cursor ?? lesson.endMin, lesson.endMin);
      continue;
    }

    // Never earlier than the hour they agreed to, never before the
    // window opens, never on top of the lesson in front.
    const floor = Math.max(cursor, windowStartMin, lesson.startMin - FLEXIBLE_SHIFT_MINUTES);
    const target = alignUp(floor);

    if (target < lesson.startMin) {
      moves.push({
        lessonId: lesson.occ.lessonId,
        clientId: lesson.occ.clientId ?? null,
        title: lesson.occ.title ?? null,
        durationMins: lesson.duration,
        fromMin: lesson.startMin,
        toMin: target,
        from: lesson.occ.start,
        to: dayTimeToUtc(input.date, minutesToTime(target)).toISOString(),
        fromLabel: minutesToTime(lesson.startMin),
        toLabel: minutesToTime(target)
      });
      lesson.startMin = target;
      lesson.endMin = target + lesson.duration;
    }

    cursor = Math.max(cursor, lesson.endMin);
  }

  const after = deadTime(placed.map(toInterval));
  return {
    moves,
    deadBefore: before.dead,
    deadAfter: after.dead,
    saved: Math.max(0, before.dead - after.dead)
  };
}

function toInterval(l: { startMin: number; endMin: number; weight: number }): Interval {
  return { startMin: l.startMin, endMin: l.endMin, weight: l.weight };
}

function alignUp(minutes: number): number {
  return Math.ceil(minutes / SLOT_ALIGN_MINUTES) * SLOT_ALIGN_MINUTES;
}
