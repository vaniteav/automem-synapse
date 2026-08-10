import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure"];
const TOOL_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure"];

test("hooks.json wires every event with inline node commands", async () => {
  const h = JSON.parse(await readFile(new URL("../hooks/hooks.json", import.meta.url)));
  for (const ev of EVENTS) {
    assert.ok(h.hooks[ev], `${ev} must be wired`);
    assert.match(h.hooks[ev][0].hooks[0].command, /node .*CLAUDE_PLUGIN_ROOT.*scripts/);
    assert.equal(typeof h.hooks[ev][0].hooks[0].timeout, "number", `${ev} must carry a timeout`);
  }
  for (const ev of TOOL_EVENTS) {
    const m = h.hooks[ev][0].matcher;
    assert.match(m, /store_memory/);
    assert.match(m, /delete_memory/);
    assert.match(m, /associate_memories/);
  }
});

// The gate logs `allow` before the write runs; these two events log what the write actually
// did. They only correlate if they see the same calls, so their matcher must be the gate's.
test("the outcome events use the SAME matcher as the gate, so every gated write is followed up", async () => {
  const h = JSON.parse(await readFile(new URL("../hooks/hooks.json", import.meta.url)));
  assert.equal(h.hooks.PostToolUse[0].matcher, h.hooks.PreToolUse[0].matcher);
  assert.equal(h.hooks.PostToolUseFailure[0].matcher, h.hooks.PreToolUse[0].matcher);
});

test("both outcome events run the one outcome recorder", async () => {
  const h = JSON.parse(await readFile(new URL("../hooks/hooks.json", import.meta.url)));
  for (const ev of ["PostToolUse", "PostToolUseFailure"]) {
    assert.match(h.hooks[ev][0].hooks[0].command, /post-tool-use\.mjs/);
  }
});

test("SessionStart matcher fires exactly where context does NOT already carry memories", async () => {
  const h = JSON.parse(await readFile(new URL("../hooks/hooks.json", import.meta.url)));
  const re = new RegExp("^(" + h.hooks.SessionStart[0].matcher + ")$");
  // Context is empty / wiped / possibly-truncated ⇒ recall is needed.
  assert.match("startup", re);
  assert.match("clear", re);   // /clear wipes context; memories must be re-injected
  assert.match("compact", re);
  // These inherit the prior transcript, so the memories are already present.
  assert.doesNotMatch("resume", re);
  assert.doesNotMatch("fork", re);
});

test("tool-event matchers fire for ANY mcp server name, not just 'automem' (no fail-open on rename)", async () => {
  const h = JSON.parse(await readFile(new URL("../hooks/hooks.json", import.meta.url)));
  for (const ev of TOOL_EVENTS) {
    const re = new RegExp(h.hooks[ev][0].matcher);
    assert.match("mcp__automem__store_memory", re, ev);     // default
    assert.match("mcp__mem__store_memory", re, ev);          // renamed
    assert.match("mcp__my_automem__delete_memory", re, ev);  // renamed + other write tool
    assert.match("mcp__mem__associate_memories", re, ev);
    assert.doesNotMatch("mcp__automem__recall_memory", re, ev); // read tools stay out
    // These events are wired to the write matcher, NOT to every tool call — the whole cost
    // argument for adding them rests on that.
    assert.doesNotMatch("Bash", re, ev);
    assert.doesNotMatch("Edit", re, ev);
  }
});
