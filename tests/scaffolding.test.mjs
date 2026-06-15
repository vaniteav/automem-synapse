import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("plugin manifest declares name and version", async () => {
  const m = JSON.parse(await readFile(new URL("../.claude-plugin/plugin.json", import.meta.url)));
  assert.equal(m.name, "automem-synapse");
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
});
