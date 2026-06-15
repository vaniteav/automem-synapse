import { test } from "node:test";
import assert from "node:assert/strict";
import { detectProject } from "../scripts/lib/project-detect.mjs";

const config = { projectDetection: { "automem-synapse": "automem-synapse", "teatools-osc-hub": "teatools" } };

test("maps a known folder name in cwd to its project tag", () => {
  const p = detectProject("C:/dev/automem-synapse", "fix the gate", config);
  assert.equal(p.projectTag, "automem-synapse");
  assert.equal(p.projectLabel, "automem-synapse");
});

test("returns empty project when nothing matches", () => {
  const p = detectProject("C:/tmp/unknown", "hello", config);
  assert.equal(p.projectTag, "");
});
