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

test("delete_memory is allowed (no content candidate to police)", async () => {
  const { stdout } = await run({ session_id: "s", tool_name: "mcp__automem__delete_memory", tool_input: { memory_id: "x" } }, base);
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
