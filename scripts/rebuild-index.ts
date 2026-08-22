/* =====================================================================
   Build the day index from the command line.

   The same code path /api/rebuild-day and the scheduled function use —
   this is only a different way to press the button, for the first build
   and for repairing by hand if something ever goes badly wrong.

       npm run rebuild            # the whole indexed range
       npm run rebuild -- --dry   # report what would be written

   Needs serviceAccountKey.json, or the FIREBASE_* environment variables.
   ===================================================================== */

import { loadExceptions, loadLessons, rebuildAll } from "../netlify/functions/_lib/store.js";
import { buildDayIndex, dayKeysBetween, indexRange } from "../src/shared/dayIndex.js";

const dry = process.argv.includes("--dry");
const now = new Date();
const { from, to } = indexRange(now);

console.log(`Index range: ${from} -> ${to} (${dayKeysBetween(from, to).length} days)`);

if (dry) {
  const [lessons, exceptions] = await Promise.all([loadLessons(), loadExceptions()]);
  const index = buildDayIndex(lessons, exceptions, dayKeysBetween(from, to), { now });
  const busy = index.filter(d => d.lessons.length > 0);
  const total = index.reduce((sum, d) => sum + d.lessons.length, 0);

  console.log(`\nWould write ${index.length} documents: ${total} lessons across ${busy.length} days.\n`);
  for (const day of busy) {
    console.log(`  ${day.date}  ${day.lessons.map(l =>
      `${new Date(l.start).toISOString().slice(11, 16)}Z ${l.title ?? "?"}`).join(" | ")}`);
  }
  console.log("\nDry run — nothing written.");
} else {
  const result = await rebuildAll(now);
  console.log(`\nWrote ${result.days} day documents, ${result.lessons} lessons.`);
  if (result.moved.length > 0) {
    console.log(`Detected ${result.moved.length} moved booking(s):`, result.moved);
  }
}

process.exit(0);
