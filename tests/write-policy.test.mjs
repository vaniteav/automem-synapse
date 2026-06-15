import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCandidate, evaluateWritePolicy, evaluateEditPolicy } from "../scripts/lib/write-policy.mjs";

const CONFIG = {
  writePolicy: {
    mode: "safe-auto",
    autoWriteCategories: ["technical-decision", "agent-pattern", "bug-fix", "tooling-lesson"],
    confirmCategories: ["personal", "financial", "private", "identity"],
    blockedCategories: ["secret", "credential", "api-key", "raw-transcript"],
    minImportanceToWrite: 0.7,
    alwaysTag: ["agent:claude-code"],
    defaultSource: "claude-code-session",
  },
  behavior: { preferredContentLength: 500, maxContentLength: 2000 },
};

test("normalize lowercases/dedupes tags, clamps importance, adds alwaysTag", () => {
  const n = normalizeCandidate({ content: "  x   y ", type: "Decision", tags: ["DB", "db"], importance: 5 }, CONFIG);
  assert.equal(n.content, "x y");
  assert.deepEqual(n.tags.sort(), ["agent:claude-code", "db"].sort());
  assert.equal(n.importance, 1);
});

test("secret content is blocked", () => {
  const d = evaluateWritePolicy({ content: "token = abcdefghijklmnopqrstuvwx", type: "Decision", tags: [], importance: 0.9 }, CONFIG);
  assert.equal(d.action, "block");
});

test("low importance is blocked", () => {
  const d = evaluateWritePolicy({ content: "minor note", type: "Context", tags: [], importance: 0.2 }, CONFIG);
  assert.equal(d.action, "block");
});

test("auto category in safe-auto auto-writes", () => {
  const d = evaluateWritePolicy({ content: "Chose X over Y", type: "Decision", tags: ["decision"], importance: 0.9 }, CONFIG);
  assert.equal(d.action, "auto");
});

test("confirm category requires confirmation", () => {
  const d = evaluateWritePolicy({ content: "personal note about health", type: "Context", tags: ["personal"], importance: 0.9 }, CONFIG);
  assert.equal(d.action, "confirm");
});

test("edit policy: secrets blocked, sensitive tags confirm, plain edits allow (no empty/importance/dedupe checks)", () => {
  assert.equal(evaluateEditPolicy({ content: "token=abcdefghijklmnopqrstuvwx", tags: [] }, CONFIG).action, "block");
  assert.equal(evaluateEditPolicy({ content: "ok", tags: ["personal"] }, CONFIG).action, "confirm");
  assert.equal(evaluateEditPolicy({ content: "tweak wording", tags: ["notes"] }, CONFIG).action, "allow");
  assert.equal(evaluateEditPolicy({ tags: ["notes"] }, CONFIG).action, "allow"); // empty content is fine for an edit
});

test("edit policy allows edits that omit content (null or absent)", () => {
  assert.equal(evaluateEditPolicy({ content: null, tags: ["notes"] }, CONFIG).action, "allow");
  assert.equal(evaluateEditPolicy({ tags: ["notes"] }, CONFIG).action, "allow");
  assert.equal(evaluateEditPolicy({ memory_id: "m1" }, CONFIG).action, "allow");
});

test("edit policy serializes non-string content for the length cap and secret scan", () => {
  const hugeObj = { value: "x".repeat(CONFIG.behavior.maxContentLength + 1) };
  assert.equal(evaluateEditPolicy({ content: hugeObj, tags: ["notes"] }, CONFIG).action, "block", "oversized object content must not bypass the cap");
  assert.equal(evaluateEditPolicy({ content: { note: "Authorization: Bearer abcdef0123456789ABCDEF" }, tags: ["notes"] }, CONFIG).action, "block", "secret nested in non-string content must be caught");
});

test("over-preferred-length note is an advisory, not mixed into gating reasons", () => {
  const long = "word ".repeat(150); // > 500 preferred, < 2000 hard
  const d = evaluateWritePolicy({ content: long, type: "Context", tags: ["misc"], importance: 0.9 }, CONFIG);
  assert.equal(d.action, "propose");
  assert.ok(Array.isArray(d.advisories) && d.advisories.some((a) => /preferred/.test(a)), "advisory present");
  assert.equal(d.reasons.some((r) => /preferred/.test(r)), false, "advisory must not appear as a gating reason");
});

test("edit policy blocks content over the hard length cap", () => {
  const huge = "x".repeat(CONFIG.behavior.maxContentLength + 1);
  assert.equal(evaluateEditPolicy({ content: huge, tags: ["notes"] }, CONFIG).action, "block");
});

test("mode off blocks edits too", () => {
  const off = { writePolicy: { ...CONFIG.writePolicy, mode: "off" }, behavior: CONFIG.behavior };
  assert.equal(evaluateEditPolicy({ content: "anything", tags: ["notes"] }, off).action, "block");
});
