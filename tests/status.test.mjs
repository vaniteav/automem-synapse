import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const status = fileURLToPath(new URL("../scripts/status.mjs", import.meta.url));
const mockClient = new URL("./fixtures/mock-client.mjs", import.meta.url).href; // file:// URL

test("status prints health and config summary as JSON", async () => {
  const out = await new Promise((resolve) => {
    execFile("node", [status], { env: { ...process.env, AUTOMEM_SYNAPSE_TEST_CLIENT: mockClient, AUTOMEM_API_KEY: "tok" } }, (e, stdout) => resolve(stdout));
  });
  const j = JSON.parse(out);
  assert.equal(j.healthy, true);
  assert.equal(j.writePolicyMode, "safe-auto");
  assert.equal(typeof j.serverUrl, "string");
  assert.equal(j.matcherMismatch, null); // default mcpServerName matches the matcher
  assert.ok("lastHookResult" in j);      // observability surface present
});

test("no false matcher-mismatch warning when mcpServerName is renamed (matcher is server-agnostic)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "amsyn-status-"));
  const p = join(dir, "automem-synapse.json");
  await writeFile(p, JSON.stringify({ mcpServerName: "mem" }));
  const out = await new Promise((resolve) => {
    execFile("node", [status], { env: { ...process.env, AUTOMEM_SYNAPSE_TEST_CLIENT: mockClient, AUTOMEM_API_KEY: "tok", AUTOMEM_CONFIG_PATH: p } }, (e, stdout) => resolve(stdout));
  });
  const j = JSON.parse(out);
  assert.equal(j.mcpServerName, "mem");
  assert.equal(j.matcherMismatch, null); // the broadened matcher covers any server, so no spurious warning
});

// ---------------------------------------------------------------------------
// Downstream write outcomes. The gate logs `allow` BEFORE the write executes, so an
// allow line on its own says nothing about whether the memory was saved. These assert
// that status joins gate decisions to the outcome records post-tool-use.mjs writes.
// ---------------------------------------------------------------------------

const gate = (toolUseId, decision = "allow") => ({ ts: "2026-08-10T00:00:00.000Z", hook: "PreToolUse", tool: "store_memory", session: "s1", toolUseId, decision });
const HOOK_OF = { failure: "PostToolUseFailure", "denied-downstream": "PermissionDenied" };
const outcome = (toolUseId, outcome, extra = {}) => ({ ts: "2026-08-10T00:00:01.000Z", hook: HOOK_OF[outcome] || "PostToolUse", tool: "store_memory", session: "s1", toolUseId, outcome, ...extra });

function runStatus(cfgPath) {
  return new Promise((resolve) => {
    execFile("node", [status], { env: { ...process.env, AUTOMEM_SYNAPSE_TEST_CLIENT: mockClient, AUTOMEM_API_KEY: "tok", AUTOMEM_CONFIG_PATH: cfgPath } }, (e, stdout) => resolve(JSON.parse(stdout)));
  });
}

// Writes `text` as the log file (records, or a raw string for malformed input) and runs status.
async function statusWithLog(text) {
  const dir = await mkdtemp(join(tmpdir(), "amsyn-status-"));
  const logFile = join(dir, "synapse.log");
  const cfgPath = join(dir, "automem-synapse.json");
  await writeFile(logFile, Array.isArray(text) ? text.map((r) => JSON.stringify(r)).join("\n") + "\n" : text);
  await writeFile(cfgPath, JSON.stringify({ observability: { logFile } }));
  return runStatus(cfgPath);
}

test("write outcomes: confirmed, failed downstream, and allowed-but-never-confirmed are told apart", async () => {
  const j = await statusWithLog([
    gate("t1"), outcome("t1", "success"),
    gate("t2"), outcome("t2", "failure", { error: "upstream returned 503" }),
    gate("t3"), // allowed, nothing ever confirmed it — the silent-failure case
  ]);
  assert.equal(j.writeOutcomes.allowed, 3);
  assert.equal(j.writeOutcomes.confirmed, 1);
  assert.equal(j.writeOutcomes.failedDownstream, 1);
  assert.equal(j.writeOutcomes.unconfirmed, 1);
  assert.equal(j.writeOutcomes.orphanOutcomes, 0);
});

test("a write the gate allowed and auto mode then denied is its own bucket, not an unconfirmed write", async () => {
  // The gate's `allow` is permission from this plugin, not permission to run: auto mode can
  // deny the call afterwards, and that denial fires neither PostToolUse nor PostToolUseFailure.
  // Before `permission-denied.mjs` existed there was no line at all and the reporter assumed
  // an `allow` always runs, so this write was reported as allowed-but-never-confirmed — a
  // decision the user's safety layer made, misfiled as a silent server failure.
  const j = await statusWithLog([
    gate("t1"), outcome("t1", "success"),
    gate("t2"), outcome("t2", "denied-downstream", { reason: "Blocked by classifier" }),
  ]);
  assert.equal(j.writeOutcomes.deniedDownstream, 1);
  assert.equal(j.writeOutcomes.unconfirmed, 0, "a denied write is known, not unknown");
  assert.equal(j.writeOutcomes.allowed, 1, "it never reached AutoMem, so it is not an attempted write");
  assert.equal(j.writeOutcomes.confirmed, 1);
  assert.equal(j.writeOutcomes.failedDownstream, 0); // a denial is not a server fault
  assert.equal(j.writeOutcomes.orphanOutcomes, 0);
});

test("a downstream denial of an ask/no-opinion write is counted too, not silently dropped", async () => {
  // no-opinion hands the call to the normal permission flow; in auto mode that flow can deny it.
  const j = await statusWithLog([gate("t1", "no-opinion"), outcome("t1", "denied-downstream")]);
  assert.equal(j.writeOutcomes.deniedDownstream, 1);
  assert.equal(j.writeOutcomes.allowed, 0);
  assert.equal(j.writeOutcomes.orphanOutcomes, 0);
});

test("a downstream failure registers as lastFailure (the old predicate could only see gate denials)", async () => {
  const j = await statusWithLog([gate("t1"), outcome("t1", "failure", { error: "upstream returned 503" })]);
  assert.ok(j.lastFailure, "a write that cleared the gate and then failed is still a failure");
  assert.equal(j.lastFailure.outcome, "failure");
});

test("a failure with no error text still registers as lastFailure", async () => {
  // An abort arrives with no `error` string, so keying on `l.error` alone would miss it.
  const j = await statusWithLog([gate("t1"), outcome("t1", "failure", { interrupted: true })]);
  assert.equal(j.lastFailure?.outcome, "failure");
});

// ---------------------------------------------------------------------------
// `lastDenial`, kept separate from `lastFailure` on purpose. The handler records a bounded
// `reason` on every denial; until this field existed nothing ever showed it, so a user hitting
// "Classifier unavailable" saw a count in `deniedDownstream` and no way to learn why.
// ---------------------------------------------------------------------------

test("a downstream denial registers as lastDenial, carrying the reason auto mode gave", async () => {
  const j = await statusWithLog([gate("t1"), outcome("t1", "denied-downstream", { reason: "Classifier unavailable" })]);
  assert.ok(j.lastDenial, "the denial the handler recorded must be reachable from the report");
  assert.equal(j.lastDenial.outcome, "denied-downstream");
  assert.equal(j.lastDenial.reason, "Classifier unavailable"); // the whole point: the WHY, not just the count
  assert.equal(j.lastDenial.toolUseId, "t1");
});

test("a denial does NOT register as lastFailure — it is a decision, not a fault", async () => {
  // Folding denials into `lastFailure` would put the user's own safety layer next to timeouts
  // and 5xxs, and send them hunting a server fault that does not exist.
  const j = await statusWithLog([gate("t1"), outcome("t1", "denied-downstream", { reason: "Blocked by classifier" })]);
  assert.equal(j.lastFailure, null, "a denial must never read as a server failure");
  assert.equal(j.lastDenial?.reason, "Blocked by classifier");
});

test("a downstream failure registers as lastFailure and NOT as lastDenial", async () => {
  // The separation has to hold in both directions, or the two fields are just one field twice.
  const j = await statusWithLog([gate("t1"), outcome("t1", "failure", { error: "upstream returned 503" })]);
  assert.equal(j.lastFailure?.outcome, "failure");
  assert.equal(j.lastDenial, null);
});

test("lastDenial is null when nothing was denied", async () => {
  const j = await statusWithLog([gate("t1"), outcome("t1", "success")]);
  assert.equal(j.lastDenial, null);
  assert.equal(j.lastFailure, null);
});

test("lastDenial reports the most recent denial, like lastFailure reports the most recent failure", async () => {
  const j = await statusWithLog([
    gate("t1"), outcome("t1", "denied-downstream", { reason: "Blocked by classifier" }),
    gate("t2"), outcome("t2", "denied-downstream", { reason: "Classifier unavailable" }),
  ]);
  assert.equal(j.lastDenial.reason, "Classifier unavailable");
  assert.equal(j.lastDenial.toolUseId, "t2");
});

test("gate decisions that never reached AutoMem are not counted as writes", async () => {
  const j = await statusWithLog([
    gate("t1", "deny"),
    gate("t2", "ask"),
    gate("t3", "no-opinion"), // delete_memory: gate formed no view; the permission flow decided
  ]);
  assert.equal(j.writeOutcomes.allowed, 0);
  assert.equal(j.writeOutcomes.unconfirmed, 0);
  assert.equal(j.writeOutcomes.orphanOutcomes, 0); // a gate line with no outcome is not an orphan
});

test("an outcome with no matching gate decision is its own category, not miscounted", async () => {
  // A write the gate never saw: logs rotated between the two lines, or the gate was wired later.
  const j = await statusWithLog([gate("t1"), outcome("t1", "success"), outcome("t9", "success")]);
  assert.equal(j.writeOutcomes.orphanOutcomes, 1);
  assert.equal(j.writeOutcomes.allowed, 1);       // the orphan is not invented as an allowed write
  assert.equal(j.writeOutcomes.confirmed, 1);
  assert.equal(j.writeOutcomes.unconfirmed, 0);
});

test("an outcome whose gate decision exists but was not an allow is not an orphan", async () => {
  const j = await statusWithLog([gate("t1", "no-opinion"), outcome("t1", "success")]);
  assert.equal(j.writeOutcomes.orphanOutcomes, 0);
  // The outcome proves the write ran (no-opinion handed the call to the normal permission
  // flow, which approved it) — it must be counted, not silently dropped. Regression for the
  // bug Codex found: this exact fixture used to assert `allowed: 0` here.
  assert.equal(j.writeOutcomes.allowed, 1);
  assert.equal(j.writeOutcomes.confirmed, 1);
});

test("ask/no-opinion decisions are only counted once an outcome proves they actually ran (regression)", async () => {
  const j = await statusWithLog([
    gate("t1", "ask"), outcome("t1", "success"),                          // confirm prompt approved, write happened
    gate("t2", "no-opinion"), outcome("t2", "failure", { error: "timeout" }), // delete approved via normal permission, then failed
    gate("t3", "ask"), // prompt outcome unknown (denied, or still pending) — must NOT be invented as unconfirmed
  ]);
  assert.equal(j.writeOutcomes.allowed, 2);
  assert.equal(j.writeOutcomes.confirmed, 1);
  assert.equal(j.writeOutcomes.failedDownstream, 1);
  assert.equal(j.writeOutcomes.unconfirmed, 0);
  assert.equal(j.writeOutcomes.orphanOutcomes, 0);
});

test("a log of only legacy lines (no correlation key) still yields a sane status", async () => {
  const j = await statusWithLog([
    { ts: "2026-06-01T00:00:00.000Z", hook: "PreToolUse", tool: "store_memory", decision: "allow" },
    { ts: "2026-06-01T00:00:01.000Z", hook: "PreToolUse", tool: "store_memory", decision: "allow", normalized: true },
    { ts: "2026-06-01T00:00:02.000Z", hook: "SessionStart", session: "s0", count: 3, bytes: 100, ms: 12 },
  ]);
  assert.equal(j.writeOutcomes.uncorrelatable, 2);
  // Crucially NOT reported as silent failures: unjoinable is "unknown", not "broken".
  assert.equal(j.writeOutcomes.unconfirmed, 0);
  assert.equal(j.writeOutcomes.allowed, 0);
  assert.equal(j.writeOutcomes.orphanOutcomes, 0);
  assert.equal(j.lastFailure, null);
  assert.equal(j.lastDenial, null);
  assert.ok(j.lastHookResult, "the last line is still reported");
});

test("legacy lines mixed with correlated ones do not disturb the correlated counts", async () => {
  const j = await statusWithLog([
    { ts: "2026-06-01T00:00:00.000Z", hook: "PreToolUse", tool: "store_memory", decision: "allow" },
    gate("t1"), outcome("t1", "success"),
  ]);
  assert.equal(j.writeOutcomes.uncorrelatable, 1);
  assert.equal(j.writeOutcomes.allowed, 1);
  assert.equal(j.writeOutcomes.confirmed, 1);
});

test("a garbage log line does not crash the reporter", async () => {
  const j = await statusWithLog("not json {\n" + JSON.stringify(gate("t1")) + "\n" + JSON.stringify(outcome("t1", "success")) + "\n");
  assert.equal(j.writeOutcomes.confirmed, 1);
});

test("a missing log file reports nulls rather than throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "amsyn-status-"));
  const cfgPath = join(dir, "automem-synapse.json");
  await writeFile(cfgPath, JSON.stringify({ observability: { logFile: join(dir, "nope.log") } }));
  const j = await runStatus(cfgPath);
  assert.equal(j.lastHookResult, null);
  assert.equal(j.lastFailure, null);
  assert.equal(j.lastDenial, null);
  assert.equal(j.writeOutcomes, null);
});

test("the correlation window is bounded and reported, so a huge log is not read whole", async () => {
  // 5000 records; only the last CORRELATION_WINDOW (200) may be correlated.
  const records = [];
  for (let i = 0; i < 2500; i++) { records.push(gate("t" + i)); records.push(outcome("t" + i, "success")); }
  const j = await statusWithLog(records);
  assert.ok(j.writeOutcomes.window <= 200, `window should be capped, got ${j.writeOutcomes.window}`);
  assert.ok(j.writeOutcomes.allowed <= 200);
  assert.ok(j.writeOutcomes.confirmed > 0);
});
