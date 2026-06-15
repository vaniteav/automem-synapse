import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getInjectedIds, addInjectedIds } from "../scripts/lib/session-cache.mjs";

test("round-trips injected ids per session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "amsyn-cache-"));
  assert.deepEqual(getInjectedIds("s1", dir), []);
  addInjectedIds("s1", ["a", "b"], dir);
  addInjectedIds("s1", ["b", "c"], dir);
  assert.deepEqual(getInjectedIds("s1", dir).sort(), ["a", "b", "c"]);
  assert.deepEqual(getInjectedIds("s2", dir), []); // isolated per session
});
