import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../scripts/lib/config.mjs";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("example configs are valid JSON and load", async () => {
  for (const f of ["config.minimal.json", "config.advanced.json"]) {
    const raw = await readFile(new URL("../examples/" + f, import.meta.url), "utf8");
    const obj = JSON.parse(raw); // throws if invalid
    const dir = await mkdtemp(join(tmpdir(), "amsyn-ex-"));
    const p = join(dir, "c.json");
    await writeFile(p, JSON.stringify(obj));
    const cfg = loadConfig(p);
    assert.equal(typeof cfg.writePolicy.mode, "string");
  }
});

test("marketplace.json lists this plugin", async () => {
  const m = JSON.parse(await readFile(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(m.plugins));
  assert.equal(m.plugins.some((p) => p.name === "automem-synapse"), true);
});
