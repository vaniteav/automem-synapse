import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
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

export function addInjectedIds(sessionId, ids, base) {
  // Append-only: each call only appends, never read-modify-writes, so concurrent hook
  // processes for the same session can't lose each other's ids (no lockfile needed).
  // Small O_APPEND writes don't interleave mid-line; getInjectedIds dedups on read.
  const fresh = (ids || []).filter(Boolean);
  if (!fresh.length) return;
  try { appendFileSync(fileFor(sessionId, base), fresh.map((id) => id + "\n").join("")); }
  catch { /* best-effort */ }
}

