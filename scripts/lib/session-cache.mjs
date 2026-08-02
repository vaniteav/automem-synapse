import { readFileSync, appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function dir(base) {
  const d = base || join(tmpdir(), "automem-synapse");
  try { mkdirSync(d, { recursive: true }); } catch { /* exists */ }
  return d;
}
function fileFor(sessionId, base) {
  const safe = String(sessionId || "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
  return join(dir(base), "session-" + safe + ".json");
}

export function getInjectedIds(sessionId, base) {
  // Append-only newline-delimited id log; dedup on read.
  try {
    const set = new Set();
    for (const line of readFileSync(fileFor(sessionId, base), "utf8").split("\n")) {
      const id = line.trim();
      if (id) set.add(id);
    }
    return [...set];
  } catch { return []; }
}

// These files are append-only and nothing removed them, so they accumulated for the life
// of the install — measured 2026-08-02 on a 7-week-old install: 103 files, 364 KB.
//
// Pruned by AGE on SessionStart rather than by wiring a SessionEnd hook. SessionEnd does
// not fire when the process is killed or crashes, which is exactly the case that leaks;
// age-based sweeping catches those too. It also avoids adding a fourth hook event, since
// every event is another process spawn on a plugin whose whole point is staying out of
// the way. SessionStart already runs, so this is free.
//
// Best-effort throughout: a cache-hygiene routine must never be able to break a session.
export function pruneOldSessions(maxAgeMs, base, now) {
  const cutoff = (now ?? Date.now()) - maxAgeMs;
  let removed = 0;
  try {
    const d = dir(base);
    for (const name of readdirSync(d)) {
      if (!name.startsWith("session-") || !name.endsWith(".json")) continue;
      const f = join(d, name);
      try {
        if (statSync(f).mtimeMs < cutoff) { unlinkSync(f); removed++; }
      } catch { /* raced with another session, or unreadable — skip */ }
    }
  } catch { /* no dir yet, or unreadable — nothing to prune */ }
  return removed;
}

export function addInjectedIds(sessionId, ids, base) {
  // Append-only: each call only appends, never read-modify-writes, so concurrent hook
  // processes for the same session can't lose each other's ids (no lockfile needed).
  // Small O_APPEND writes don't interleave mid-line; getInjectedIds dedups on read.
  const fresh = (ids || []).filter(Boolean);
  if (!fresh.length) return;
  try { appendFileSync(fileFor(sessionId, base), fresh.map((id) => id + "\n").join("")); }
  catch { /* best-effort */ }
}

