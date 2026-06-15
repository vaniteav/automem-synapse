import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, DEFAULTS } from "../scripts/lib/config.mjs";

test("missing config file returns defaults with token from env", async () => {
  process.env.AUTOMEM_API_KEY = "tok-123";
  const cfg = loadConfig("C:/nonexistent/automem-synapse.json");
  assert.equal(cfg.writePolicy.mode, "safe-auto");
  assert.equal(cfg.server.token, "tok-123");
});

test("user config overrides defaults shallowly per section", async () => {
  const dir = await mkdtemp(join(tmpdir(), "amsyn-"));
  const p = join(dir, "automem-synapse.json");
  await writeFile(p, JSON.stringify({ writePolicy: { mode: "confirm-all", minImportanceToWrite: 0.5 } }));
  const cfg = loadConfig(p);
  assert.equal(cfg.writePolicy.mode, "confirm-all");
  assert.equal(cfg.writePolicy.minImportanceToWrite, 0.5);
  // untouched defaults survive
  assert.deepEqual(cfg.writePolicy.blockedCategories, DEFAULTS.writePolicy.blockedCategories);
});

test("projectDetection/projectOverrides never alias the shared DEFAULTS object", () => {
  const a = loadConfig("C:/nonexistent/automem-synapse.json");
  const b = loadConfig("C:/nonexistent/automem-synapse.json");
  assert.notEqual(a.projectOverrides, DEFAULTS.projectOverrides);   // fresh object, not the shared ref
  assert.notEqual(a.projectDetection, DEFAULTS.projectDetection);
  assert.notEqual(a.projectOverrides, b.projectOverrides);          // and fresh per call
});
