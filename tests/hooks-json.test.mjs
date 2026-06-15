import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("hooks.json wires the three events with inline node commands", async () => {
  const h = JSON.parse(await readFile(new URL("../hooks/hooks.json", import.meta.url)));
  assert.ok(h.hooks.SessionStart && h.hooks.UserPromptSubmit && h.hooks.PreToolUse);
  const pre = h.hooks.PreToolUse[0];
  assert.match(pre.matcher, /store_memory/);
  assert.match(pre.matcher, /delete_memory/);
  assert.match(pre.matcher, /associate_memories/);
  for (const ev of ["SessionStart", "UserPromptSubmit", "PreToolUse"]) {
    assert.match(h.hooks[ev][0].hooks[0].command, /node .*CLAUDE_PLUGIN_ROOT.*scripts/);
  }
  assert.match(h.hooks.SessionStart[0].matcher, /startup\|compact/);
});

test("PreToolUse matcher fires for ANY mcp server name, not just 'automem' (no fail-open on rename)", async () => {
  const h = JSON.parse(await readFile(new URL("../hooks/hooks.json", import.meta.url)));
  const re = new RegExp(h.hooks.PreToolUse[0].matcher);
  assert.match("mcp__automem__store_memory", re);     // default
  assert.match("mcp__mem__store_memory", re);          // renamed
  assert.match("mcp__my_automem__delete_memory", re);  // renamed + other write tool
  assert.match("mcp__mem__associate_memories", re);
  assert.doesNotMatch("mcp__automem__recall_memory", re); // read tools stay out
});
