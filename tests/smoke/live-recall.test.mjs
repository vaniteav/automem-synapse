import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../scripts/lib/config.mjs";
import { createAutomemClient } from "../../scripts/lib/automem-client.mjs";

test("live: health + recall round-trip", { skip: !process.env.AUTOMEM_API_KEY }, async () => {
  const cfg = loadConfig();
  const client = createAutomemClient({ url: cfg.server.url, token: cfg.server.token, timeoutMs: 15000 });
  const h = await client.health();
  assert.equal(h.ok, true);
  const { text } = await client.recall("working style", { limit: 1 });
  assert.match(text, /memor/i); // "Found N memories" or "No memories"
});
