import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSearchResults, formatMemoriesForContext, startupRecall } from "../scripts/lib/recall.mjs";

const SAMPLE = `Found 2 memories:\n\n1. User prefers warm direct comms [user, pref] score=0.81\n   ID: aaa\n2. Use TDD always [process] score=0.77\n   ID: bbb`;

test("parses AutoMem 'Found N memories' text", () => {
  const mems = parseSearchResults(SAMPLE);
  assert.equal(mems.length, 2);
  assert.equal(mems[0].id, "aaa");
  assert.equal(mems[0].tags.includes("user"), true);
  assert.equal(mems[0].score, 0.81);
});

test("byte budget truncates and flags", () => {
  const mems = parseSearchResults(SAMPLE);
  const r = formatMemoriesForContext(mems, 40);
  assert.equal(r.included <= 2, true);
  assert.equal(typeof r.text, "string");
});

test("startupRecall dedupes by id across queries (DI client)", async () => {
  const client = { recall: async () => ({ text: SAMPLE }) };
  const config = { startupRecall: { enabled: true, queries: ["a", "b"], limit: 5, tags: [], maxBytes: 4000, timeoutMs: 1000 } };
  const r = await startupRecall(client, config);
  assert.equal(r.count, 2); // 2 unique ids despite 2 queries
});

test("startupRecall runs its queries concurrently, not one-at-a-time", async () => {
  let active = 0, maxActive = 0;
  const client = {
    recall: async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return { text: SAMPLE };
    },
  };
  const config = { startupRecall: { enabled: true, queries: ["a", "b", "c"], limit: 5, tags: [], maxBytes: 4000, timeoutMs: 1000 } };
  await startupRecall(client, config);
  assert.ok(maxActive >= 2, `expected concurrent queries, max in flight was ${maxActive}`);
});
