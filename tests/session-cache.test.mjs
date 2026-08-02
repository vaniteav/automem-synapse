import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utimesSync } from "node:fs";
import { getInjectedIds, addInjectedIds, pruneOldSessions } from "../scripts/lib/session-cache.mjs";

test("round-trips injected ids per session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "amsyn-cache-"));
  assert.deepEqual(getInjectedIds("s1", dir), []);
  addInjectedIds("s1", ["a", "b"], dir);
  addInjectedIds("s1", ["b", "c"], dir);
  assert.deepEqual(getInjectedIds("s1", dir).sort(), ["a", "b", "c"]);
  assert.deepEqual(getInjectedIds("s2", dir), []); // isolated per session
});

test("pruneOldSessions removes stale caches and keeps fresh ones", async () => {
  const base = await mkdtemp(join(tmpdir(), "synapse-prune-"));
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();

  addInjectedIds("old-session", ["a"], base);
  addInjectedIds("fresh-session", ["b"], base);
  // Age the first file past the cutoff by setting its mtime directly.
  const oldFile = join(base, "session-old-session.json");
  utimesSync(oldFile, new Date(now - 30 * DAY), new Date(now - 30 * DAY));

  // Control: with a cutoff older than both files, nothing is removed. Without this a
  // prune that deleted everything unconditionally would still pass the assertions below.
  assert.equal(pruneOldSessions(365 * DAY, base, now), 0, "control: nothing stale yet");

  const removed = pruneOldSessions(7 * DAY, base, now);
  assert.equal(removed, 1, "exactly the aged file");
  assert.deepEqual(getInjectedIds("old-session", base), [], "stale cache gone");
  assert.deepEqual(getInjectedIds("fresh-session", base), ["b"], "fresh cache untouched");
});

test("pruneOldSessions never throws on a missing or unreadable directory", () => {
  // Runs on every SessionStart before the token check, so it must be incapable of
  // breaking a session on a fresh or broken install.
  assert.equal(pruneOldSessions(1000, join(tmpdir(), "synapse-does-not-exist-" + now2())), 0);
});
function now2() { return Math.floor(Math.random() * 1e9); }
