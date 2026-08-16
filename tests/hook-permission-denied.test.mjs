import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hook = fileURLToPath(new URL("../scripts/permission-denied.mjs", import.meta.url));

function run(input, env = {}) {
  return new Promise((resolve) => {
    const cp = execFile("node", [hook], { env: { ...process.env, ...env } }, (err, stdout) => resolve({ code: err?.code || 0, stdout }));
    cp.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

// Each test gets its own log file + config, so assertions are on lines this test wrote.
async function withLog() {
  const dir = await mkdtemp(join(tmpdir(), "amsyn-denied-"));
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

test("an auto-mode denial of a gated write is recorded, carrying the correlation key", async () => {
  const t = await withLog();
  const { code, stdout } = await run({
    session_id: "s1",
    permission_mode: "auto",
    hook_event_name: "PermissionDenied",
    tool_name: "mcp__automem__store_memory",
    tool_input: { content: "Chose X over Y" },
    tool_use_id: "toolu_01ABC",
    reason: "Blocked by classifier",
  }, t.env);
  assert.equal(code, 0);
  // The denial already happened; exit code and stderr are ignored for this event, and the one
  // stdout lever (`retry`) is deliberately unused — this hook does not argue with the
  // permission system, it only records what it decided.
  assert.equal(stdout.trim(), "", "no hookSpecificOutput: we never ask the model to retry a denied write");
  const [line] = await t.lines();
  assert.ok(line, "expected one denial record");
  assert.equal(line.hook, "PermissionDenied");
  assert.equal(line.outcome, "denied-downstream");
  assert.equal(line.tool, "store_memory");
  assert.equal(line.toolUseId, "toolu_01ABC"); // the join key /automem-status correlates on
  assert.equal(line.session, "s1");
  assert.equal(line.reason, "Blocked by classifier");
  assert.ok(line.ts, "log convention: ts first");
});

test("a denial with no reason text still records the outcome", async () => {
  const t = await withLog();
  const { code } = await run({
    session_id: "s1", hook_event_name: "PermissionDenied",
    tool_name: "mcp__automem__delete_memory", tool_use_id: "toolu_01ABC",
  }, t.env);
  assert.equal(code, 0);
  const [line] = await t.lines();
  assert.equal(line.outcome, "denied-downstream"); // the fact of the denial is the load-bearing part
  assert.equal(line.tool, "delete_memory");
  assert.equal("reason" in line, false);
});

test("PermissionDenied never copies tool_input into the log (it is the memory content)", async () => {
  const t = await withLog();
  await run({
    session_id: "s1",
    hook_event_name: "PermissionDenied",
    tool_name: "mcp__automem__store_memory",
    tool_input: { content: "SUPER-SECRET-MEMORY-BODY" },
    tool_use_id: "toolu_01ABC",
    reason: "Blocked by classifier",
  }, t.env);
  const raw = JSON.stringify(await t.lines());
  assert.equal(raw.includes("SUPER-SECRET-MEMORY-BODY"), false);
});

test("a long reason is truncated so a classifier quoting the call cannot fill the log", async () => {
  const t = await withLog();
  await run({
    session_id: "s1", hook_event_name: "PermissionDenied",
    tool_name: "mcp__automem__store_memory", tool_use_id: "toolu_01ABC",
    reason: "Auto mode could not evaluate this action and is blocking it for safety. " + "A".repeat(5000),
  }, t.env);
  const [line] = await t.lines();
  assert.ok(line.reason.length < 300, `reason should be capped, got ${line.reason.length}`);
  assert.match(line.reason, /truncated/);
  assert.match(line.reason, /^Auto mode could not evaluate/); // the diagnostic head is what survives
});

test("a reason echoing a secret is reduced to finding KINDS, never the value", async () => {
  const t = await withLog();
  const secret = "sk-ant-" + "A".repeat(30);
  await run({
    session_id: "s1", hook_event_name: "PermissionDenied",
    tool_name: "mcp__automem__store_memory", tool_use_id: "toolu_01ABC",
    reason: `Refusing to store credential material: ${secret}`,
  }, t.env);
  const raw = JSON.stringify(await t.lines());
  assert.equal(raw.includes(secret), false, "the matched secret value must never reach the log");
  assert.match(raw, /anthropic-key/); // the kind is what gets recorded
});

test("a non-AutoMem tool logs nothing and exits 0", async () => {
  // Auto mode denies plenty of Bash calls. Those are Claude Code's business to report, not
  // this plugin's — and nothing in our log could be joined to them anyway.
  const t = await withLog();
  const { code, stdout } = await run({
    session_id: "s1", hook_event_name: "PermissionDenied",
    tool_name: "Bash", tool_input: { command: "rm -rf /tmp/build" },
    tool_use_id: "toolu_01ABC", reason: "Blocked by classifier",
  }, t.env);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), "");
  assert.deepEqual(await t.lines(), []);
});

test("a read tool on OUR server logs nothing (only writes are correlated)", async () => {
  const t = await withLog();
  await run({
    session_id: "s1", hook_event_name: "PermissionDenied",
    tool_name: "mcp__automem__recall_memory", tool_input: { query: "x" },
    tool_use_id: "toolu_01ABC", reason: "Blocked by classifier",
  }, t.env);
  assert.deepEqual(await t.lines(), []);
});

test("narrowing follows the CONFIGURED server name, like the gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "amsyn-denied-"));
  const logFile = join(dir, "synapse.log");
  const cfgPath = join(dir, "automem-synapse.json");
  await writeFile(cfgPath, JSON.stringify({ mcpServerName: "mem", observability: { logFile } }));
  const env = { AUTOMEM_CONFIG_PATH: cfgPath, AUTOMEM_API_KEY: "tok" };
  const read = async () => { try { return (await readFile(logFile, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

  await run({ hook_event_name: "PermissionDenied", tool_name: "mcp__automem__store_memory", tool_use_id: "a" }, env);
  assert.deepEqual(await read(), [], "the default server name is not this install's server");

  await run({ hook_event_name: "PermissionDenied", tool_name: "mcp__mem__store_memory", tool_use_id: "b" }, env);
  const lines = await read();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].toolUseId, "b");
});

test("malformed stdin exits 0 silently — the denial already stands, so erroring is pure downside", async () => {
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
