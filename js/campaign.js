// The built-in "🗺️ Aventure" level sequence — Capevil's own official campaign,
// separate from the community/admin-approved levels in Supabase.
//
// Workflow: Caroline builds a level in the editor, titles it "Niveau N" (the
// title box at the top of the editor — this is also what names the download,
// see editor.js's #export-json), exports it with ⭳ Exporter JSON, and drops
// the file straight into the levels/ folder at the project root, next to
// index.html. Nothing else ever needs to change: discoverCampaignLevels()
// below finds levels/Niveau 1.json, levels/Niveau 2.json, … automatically at
// load time by probing sequential numbers until one is missing. No manifest
// file, no code edits, ever — dropping in Niveau 2.json is the entire job.
import { deserializeLevel, cloneLevel } from './level-model.js';

// Memoized: every caller on a given page load (home.js, game.js) shares one
// probe pass instead of each re-fetching the whole sequence.
let discovered = null;

export function discoverCampaignLevels() {
  if (!discovered) discovered = probeAll();
  return discovered;
}

async function probeAll() {
  const found = [];
  // 500 is just a sane upper bound against an infinite loop if something
  // keeps answering 200 forever (e.g. a misconfigured server) — not a real
  // ceiling on campaign length.
  for (let n = 1; n <= 500; n++) {
    // The on-disk filename has a plain space ("Niveau 1.json"), so it's
    // encoded here for the actual fetch — the space itself is what the
    // README tells Caroline to type as the level's title, no underscore.
    const file = `levels/${encodeURIComponent(`Niveau ${n}`)}.json`;
    let res;
    try {
      res = await fetch(file, { cache: 'no-store' });
    } catch {
      break; // offline / network hiccup — stop rather than report a false gap
    }
    if (!res.ok) break; // first missing number ends the sequence: no "holes" —
                         // levels are always Niveau 1, Niveau 2, Niveau 3, one after another.
    try {
      const raw = await res.json();
      found.push({ index: found.length, file, level: deserializeLevel(raw) });
    } catch {
      break; // malformed JSON — stop rather than silently skip a broken level
    }
  }
  return found;
}

// A defensive clone for handing a discovered level to an Engine — the same
// parsed level object is shared (memoized above) across every caller on this
// page, and Engine mutates the level it's given (see editor.js's own
// `new Engine(canvas, cloneLevel(level))` for the exact same reason), so
// playing must never hand out the shared instance directly.
export function cloneCampaignLevel(entry) {
  return cloneLevel(entry.level);
}

// Sequential-unlock progress, tracked per browser (no account needed — see
// the design choice this implements: "débloqués dans l'ordre" with a
// localStorage fallback when signed out). `capevil_campaign_progress` holds
// how many levels are currently unlocked (at least 1 — the first level is
// always open).
const PROGRESS_KEY = 'capevil_campaign_progress';

export function unlockedCount() {
  let n = 1;
  try { n = parseInt(localStorage.getItem(PROGRESS_KEY), 10) || 1; } catch { /* ignore: private mode, storage blocked, etc. */ }
  return Math.max(1, n);
}

export function isUnlocked(index) {
  return index >= 0 && index < unlockedCount();
}

// Call once a campaign level is won — unlocks the next one (if any) for next
// time. Monotonic: never re-locks a level that was already unlocked (e.g. by
// replaying an earlier one).
export function markCompleted(index) {
  const next = Math.max(unlockedCount(), index + 2); // index is 0-based; +2 reaches "the one after it"
  try { localStorage.setItem(PROGRESS_KEY, String(next)); } catch { /* ignore */ }
}
