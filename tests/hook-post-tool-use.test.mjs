import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hook = fileURLToPath(new URL("../scripts/post-tool-use.mjs", import.meta.url));

function run(input, env = {}) {
  return new Promise((resolve) => {
    const cp = execFile("node", [hook], { env: { ...process.env, ...env } }, (err, stdout) => resolve({ code: err?.code || 0, stdout }));
    cp.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

// Each test gets its own log file + config, so assertions are on lines this test wrote.
async function withLog() {
  const dir = await mkdtemp(join(tmpdir(), "amsyn-post-"));
  const logFile = join(dir, "synapse.log");
  const cfgPath = join(dir, "automem-synapse.json");
  await writeFile(cfgPath, JSON.stringify({ observability: { logFile } }));
  return {
    env: { AUTOMEM_CONFIG_PATH: cfgPath, AUTOMEM_API_KEY: "tok" },
    async lines() {
      try { return (await readFile(logFile, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
      catch { return []; } // file never created ⇒ nothing was logged
    },
  };
}

test("PostToolUse success records a success outcome carrying the correlation key", async () => {
  const t = await withLog();
  const { code, stdout } = await run({
    session_id: "s1",
    hook_event_name: "PostToolUse",
    tool_name: "mcp__automem__store_memory",
    tool_input: { content: "Chose X over Y" },
    tool_response: { id: "m-42", success: true },
    tool_use_id: "toolu_01ABC",
    duration_ms: 12,
  }, t.env);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), "", "these events cannot change an outcome; stdout must stay empty");
  const [line] = await t.lines();
  assert.ok(line, "expected one outcome record");
  assert.equal(line.hook, "PostToolUse");
  assert.equal(line.outcome, "success");
  assert.equal(line.tool, "store_memory");
  assert.equal(line.toolUseId, "toolu_01ABC"); // the join key /automem-status correlates on
  assert.equal(line.session, "s1");
  assert.equal(line.ms, 12);
  assert.ok(line.ts, "log convention: ts first");
});

test("PostToolUse never copies tool_response into the log (it is the stored content)", async () => {
  const t = await withLog();
  await run({
    session_id: "s1",
    hook_event_name: "PostToolUse",
    tool_name: "mcp__automem__store_memory",
    tool_input: { content: "SUPER-SECRET-MEMORY-BODY" },
    tool_response: { stored: "SUPER-SECRET-MEMORY-BODY" },
    tool_use_id: "toolu_01ABC",
  }, t.env);
  const raw = JSON.stringify(await t.lines());
  assert.equal(raw.includes("SUPER-SECRET-MEMORY-BODY"), false);
});

test("PostToolUseFailure records a failure outcome with the error captured", async () => {
  const t = await withLog();
  const { code, stdout } = await run({
    session_id: "s1",
    hook_event_name: "PostToolUseFailure",
    tool_name: "mcp__automem__store_memory",
    tool_input: { content: "Chose X over Y" },
    tool_use_id: "toolu_01ABC",
    error: "MCP error -32603: upstream returned 503",
    is_interrupt: false,
    duration_ms: 4187,
  }, t.env);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), "");
  const [line] = await t.lines();
  assert.equal(line.hook, "PostToolUseFailure");
  assert.equal(line.outcome, "failure");
  assert.equal(line.error, "MCP error -32603: upstream returned 503");
  assert.equal(line.ms, 4187);
  assert.equal("interrupted" in line, false); // only recorded when the failure WAS an abort
});

test("an abort is marked interrupted and survives a missing error string", async () => {
  const t = await withLog();
  const { code } = await run({
    session_id: "s1",
    hook_event_name: "PostToolUseFailure",
    tool_name: "mcp__automem__store_memory",
    tool_use_id: "toolu_01ABC",
    is_interrupt: true,
  }, t.env);
  assert.equal(code, 0);
  const [line] = await t.lines();
  assert.equal(line.outcome, "failure"); // must still register as a failure with no error text
  assert.equal(line.interrupted, true);
  assert.equal("error" in line, false);
});

test("a long error is truncated so a server echoing the request cannot fill the log", async () => {
  const t = await withLog();
  await run({
    session_id: "s1",
    hook_event_name: "PostToolUseFailure",
    tool_name: "mcp__automem__store_memory",
    tool_use_id: "toolu_01ABC",
    error: "Exit code 1\n" + "A".repeat(5000),
  }, t.env);
  const [line] = await t.lines();
  assert.ok(line.error.length < 300, `error should be capped, got ${line.error.length}`);
  assert.match(line.error, /truncated/);
  assert.match(line.error, /^Exit code 1/); // the diagnostic head is what survives
});

test("an error echoing a secret is reduced to finding KINDS, never the value", async () => {
  const t = await withLog();
  const secret = "sk-ant-" + "A".repeat(30);
  await run({
    session_id: "s1",
    hook_event_name: "PostToolUseFailure",
    tool_name: "mcp__automem__store_memory",
    tool_use_id: "toolu_01ABC",
    error: `rejected payload: {"content":"${secret}"}`,
  }, t.env);
  const raw = JSON.stringify(await t.lines());
  assert.equal(raw.includes(secret), false, "the matched secret value must never reach the log");
  assert.match(raw, /anthropic-key/); // the kind is what gets recorded
});

test("a non-AutoMem tool logs nothing and exits 0", async () => {
  const t = await withLog();
  const { code, stdout } = await run({
    session_id: "s1", hook_event_name: "PostToolUse",
    tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "toolu_01ABC",
  }, t.env);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), "");
  assert.deepEqual(await t.lines(), []);
});

test("a read tool on OUR server logs nothing (only writes have outcomes to record)", async () => {
  const t = await withLog();
  await run({
    session_id: "s1", hook_event_name: "PostToolUse",
    tool_name: "mcp__automem__recall_memory", tool_input: { query: "x" }, tool_use_id: "toolu_01ABC",
  }, t.env);
  assert.deepEqual(await t.lines(), []);
});

test("narrowing follows the CONFIGURED server name, like the gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "amsyn-post-"));
  const logFile = join(dir, "synapse.log");
  const cfgPath = join(dir, "automem-synapse.json");
  await writeFile(cfgPath, JSON.stringify({ mcpServerName: "mem", observability: { logFile } }));
  const env = { AUTOMEM_CONFIG_PATH: cfgPath, AUTOMEM_API_KEY: "tok" };
  const read = async () => { try { return (await readFile(logFile, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

  await run({ hook_event_name: "PostToolUse", tool_name: "mcp__automem__store_memory", tool_use_id: "a" }, env);
  assert.deepEqual(await read(), [], "the default server name is not this install's server");

  await run({ hook_event_name: "PostToolUse", tool_name: "mcp__mem__store_memory", tool_use_id: "b" }, env);
  const lines = await read();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].toolUseId, "b");
});

test("malformed stdin exits 0 silently — these events cannot block, so erroring is pure downside", async () => {
  const t = await withLog();
  const { code, stdout } = await run("not json {", t.env);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), "");
  assert.deepEqual(await t.lines(), []);
});

test("empty stdin exits 0 silently", async () => {
  const t = await withLog();
  const { code, stdout } = await run("", t.env);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), "");
});

test("a missing hook_event_name still lands a failure on the failure side", async () => {
  // Belt-and-braces fallback: only the failure event carries a top-level `error`, so an
  // absent/renamed event name must not silently record a failed write as a success.
  const t = await withLog();
  await run({
    session_id: "s1", tool_name: "mcp__automem__store_memory",
    tool_use_id: "toolu_01ABC", error: "boom",
  }, t.env);
  const [line] = await t.lines();
  assert.equal(line.outcome, "failure");
});
