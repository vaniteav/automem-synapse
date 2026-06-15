import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("skill has frontmatter name + description and covers corrections", async () => {
  const s = await readFile(new URL("../skills/automem-synapse/SKILL.md", import.meta.url), "utf8");
  assert.match(s, /^---[\s\S]*name:\s*automem-synapse/m);
  assert.match(s, /description:/);
  assert.match(s, /correct/i); // documents correction-with-provenance
  assert.match(s, /associate_memories/);
});
