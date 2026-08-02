import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hook = fileURLToPath(new URL("../scripts/pre-tool-use.mjs", import.meta.url));
const mockClient = new URL("./fixtures/mock-client-empty.mjs", import.meta.url).href; // file:// URL (see note in Task 9)
const throwingClient = new URL("./fixtures/mock-client-throws.mjs", import.meta.url).href;

function run(input, env = {}) {
  return new Promise((resolve) => {
    const cp = execFile("node", [hook], { env: { ...process.env, ...env } }, (err, stdout) => resolve({ code: err?.code || 0, stdout }));
    cp.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}
const base = { AUTOMEM_SYNAPSE_TEST_CLIENT: mockClient, AUTOMEM_API_KEY: "tok" };

test("non-automem tool is ignored (allow, no output)", async () => {
  const { code, stdout } = await run({ tool_name: "Bash", tool_input: { command: "ls" } }, base);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), "");
});

test("secret content is denied", async () => {
  const { stdout } = await run({ session_id: "s", tool_name: "mcp__automem__store_memory", tool_input: { content: "api_key=abcdefghijklmnopqrstuvwx", type: "Decision", importance: 0.9 } }, base);
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
});

test("auto-eligible write is allowed with normalized updatedInput", async () => {
  const { stdout } = await run({ session_id: "s", tool_name: "mcp__automem__store_memory", tool_input: { content: "Chose X over Y", type: "Decision", tags: ["Decision"], importance: 0.9 } }, base);
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(out.hookSpecificOutput.updatedInput.tags.includes("agent:claude-code"), true);
  assert.equal(out.hookSpecificOutput.updatedInput.metadata.category, "technical-decision"); // derived fields folded into metadata
});

test("non-auto-category write in safe-auto asks (not silent allow)", async () => {
  const { stdout } = await run({ session_id: "s", tool_name: "mcp__automem__store_memory", tool_input: { content: "a plain context note", type: "Context", tags: ["misc"], importance: 0.9 } }, base);
  assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision, "ask");
});

test("invalid stdin fails CLOSED (deny + exit 2)", async () => {
  const { code, stdout } = await run("not json {", base);
  assert.equal(code, 2);
  assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("update_memory carrying a secret is denied", async () => {
  const { stdout } = await run({ session_id: "s", tool_name: "mcp__automem__update_memory", tool_input: { memory_id: "x", content: "token=abcdefghijklmnopqrstuvwx" } }, base);
  assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision, "deny");
});

// CHANGED 2026-08-02. This previously asserted permissionDecision === "allow", on the
// reasoning that a delete carries no content to police. That reasoning is sound and the
// conclusion did not follow: `allow` BYPASSES the permission prompt, so the plugin was
// silently auto-approving a destructive operation it had only secret-scanned. Having no
// content to police is a reason to have no opinion, not a reason to approve.
//
// Emitting nothing (exit 0, no hookSpecificOutput) is the documented no-opinion path and
// returns the decision to the normal permission flow — the same thing this script already
// does for tools that aren't ours.
test("delete_memory yields NO opinion, so the normal permission flow decides", async () => {
  const { stdout } = await run({ session_id: "s", tool_name: "mcp__automem__delete_memory", tool_input: { memory_id: "x" } }, base);
  assert.equal(stdout.trim(), "", "must not emit a permissionDecision for a destructive op");
});

test("delete_memory carrying a secret is still DENIED, not merely deferred", async () => {
  // The no-opinion path must not become a hole: an explicit deny still outranks it.
  const { stdout } = await run({ session_id: "s", tool_name: "mcp__automem__delete_memory", tool_input: { memory_id: "x", content: "sk-ant-" + "A".repeat(24) } }, base);
  assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("associate_memories is still allowed (non-destructive, payload scanned)", async () => {
  const { stdout } = await run({ session_id: "s", tool_name: "mcp__automem__associate_memories", tool_input: { memory1_id: "a", memory2_id: "b" } }, base);
  assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision, "allow");
});

test("store allow-path strips unknown fields but keeps known AutoMem fields", async () => {
  const { stdout } = await run({ session_id: "s", tool_name: "mcp__automem__store_memory", tool_input: { content: "Chose X over Y", type: "Decision", tags: ["decision"], importance: 0.9, embedding: [1, 2, 3], evil: "unvetted" } }, base);
  const ui = JSON.parse(stdout).hookSpecificOutput.updatedInput;
  assert.equal("evil" in ui, false);        // unknown field never reaches AutoMem
  assert.deepEqual(ui.embedding, [1, 2, 3]); // known AutoMem field preserved
});

test("update allow-path emits an allowlisted updatedInput dropping unknown fields", async () => {
  const { stdout } = await run({ session_id: "s", tool_name: "mcp__automem__update_memory", tool_input: { memory_id: "m1", content: "tweak wording", tags: ["notes"], evil: "x" } }, base);
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
  const ui = out.hookSpecificOutput.updatedInput;
  assert.ok(ui, "update allow should carry an allowlisted updatedInput");
  assert.equal(ui.memory_id, "m1");
  assert.equal("evil" in ui, false);
});

test("store-path log lines carry the tool name (parity with edit/delete paths)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "amsyn-log-"));
  const logFile = join(dir, "synapse.log");
  const cfgPath = join(dir, "automem-synapse.json");
  await writeFile(cfgPath, JSON.stringify({ observability: { logFile } }));
  const { stdout } = await run(
    { session_id: "s", tool_name: "mcp__automem__store_memory", tool_input: { content: "Chose X over Y", type: "Decision", tags: ["decision"], importance: 0.9 } },
    { ...base, AUTOMEM_CONFIG_PATH: cfgPath },
  );
  assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision, "allow");
  const line = (await readFile(logFile, "utf8")).trim().split("\n").map((l) => JSON.parse(l)).find((l) => l.hook === "PreToolUse" && l.decision);
  assert.ok(line, "expected a PreToolUse decision line");
  assert.equal(line.tool, "store_memory"); // store path must be grep-filterable by tool like the others
});

test("dedupe failure degrades to allow but is logged (not silently swallowed)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "amsyn-log-"));
  const logFile = join(dir, "synapse.log");
  const cfgPath = join(dir, "automem-synapse.json");
  await writeFile(cfgPath, JSON.stringify({ observability: { logFile } }));
  const { stdout } = await run(
    { session_id: "s", tool_name: "mcp__automem__store_memory", tool_input: { content: "Chose X over Y", type: "Decision", tags: ["decision"], importance: 0.9 } },
    { AUTOMEM_SYNAPSE_TEST_CLIENT: throwingClient, AUTOMEM_API_KEY: "tok", AUTOMEM_CONFIG_PATH: cfgPath },
  );
  assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision, "allow"); // degrades open by design
  const log = await readFile(logFile, "utf8");
  assert.match(log, /degraded/); // but the degrade is recorded
});
