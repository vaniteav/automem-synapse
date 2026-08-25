import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// END-TO-END CORRELATION, against the real scripts and a real log file.
//
// Every other test of this join builds its log records from a local `gate()`/`outcome()`
// helper. That is the right shape for asserting the correlator's arithmetic, but it leaves the
// joint itself untested: the helpers encode what the handlers are BELIEVED to write, so a
// handler that renamed `toolUseId`, moved `outcome`, or stopped writing a field at all would
// keep every one of those tests green while `/automem-status` silently lost the write. The
// correlation key is exactly the kind of thing that drifts, because nothing else in the repo
// reads it.
//
// So this file spawns the real `pre-tool-use.mjs` and the real `permission-denied.mjs` — the
// same way the per-hook tests do — lets them append to one real log file, and then runs the
// real `status.mjs` against that same file. Nothing here constructs a log record by hand. The
// assertion is the whole chain: the gate's `allow` and the handler's denial, written
// independently by two processes, are joined by the reporter into `deniedDownstream` and
// surfaced with the denial's reason in `lastDenial`.

const preToolUse = fileURLToPath(new URL("../scripts/pre-tool-use.mjs", import.meta.url));
const permissionDenied = fileURLToPath(new URL("../scripts/permission-denied.mjs", import.meta.url));
const status = fileURLToPath(new URL("../scripts/status.mjs", import.meta.url));
// The gate's dedupe step makes a network call. Left real it would fail, and the gate records
// that degrade with an `error` — which is itself a `lastFailure` — so the injected client is
// what keeps this test about correlation rather than about connectivity. "Found 0 memories"
// means no duplicate, so the auto-eligible write below reaches the `allow` branch.
const emptyClient = new URL("./fixtures/mock-client-empty.mjs", import.meta.url).href;
const healthyClient = new URL("./fixtures/mock-client.mjs", import.meta.url).href;

function run(script, input, env) {
  return new Promise((resolve, reject) => {
    const cp = execFile("node", [script], { env: { ...process.env, ...env } }, (err, stdout) => {
      if (err?.signal) return reject(new Error(`${script} was killed by signal ${err.signal}`));
      resolve({ code: err?.code ?? 0, stdout });
    });
    cp.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

// One temp dir per test: its own config and its own log file, so the assertions below are on
// lines these processes wrote and nothing else.
async function withLog() {
  const dir = await mkdtemp(join(tmpdir(), "amsyn-e2e-"));
  const logFile = join(dir, "synapse.log");
  const cfgPath = join(dir, "automem-synapse.json");
  await writeFile(cfgPath, JSON.stringify({ observability: { logFile } }));
  return {
    cfgPath,
    async lines() {
      try { return (await readFile(logFile, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
      catch { return []; }
    },
  };
}

test("a real gate allow and a real auto-mode denial are correlated by the real reporter", async () => {
  const t = await withLog();
  const env = { AUTOMEM_CONFIG_PATH: t.cfgPath, AUTOMEM_API_KEY: "tok" };
  const toolUseId = "toolu_01E2E";

  // 1. The gate runs for real and allows an auto-eligible write.
  const gate = await run(preToolUse, {
    session_id: "s-e2e",
    hook_event_name: "PreToolUse",
    tool_name: "mcp__automem__store_memory",
    tool_input: { content: "Chose X over Y", type: "Decision", tags: ["Decision"], importance: 0.9 },
    tool_use_id: toolUseId,
  }, { ...env, AUTOMEM_SYNAPSE_TEST_CLIENT: emptyClient });
  assert.equal(gate.code, 0);
  assert.equal(JSON.parse(gate.stdout).hookSpecificOutput.permissionDecision, "allow");

  // 2. Auto mode denies the call the gate just allowed. Separate process, same log file — the
  //    only thing tying the two lines together is the id both scripts read off the event.
  const denied = await run(permissionDenied, {
    session_id: "s-e2e",
    permission_mode: "auto",
    hook_event_name: "PermissionDenied",
    tool_name: "mcp__automem__store_memory",
    tool_input: { content: "Chose X over Y" },
    tool_use_id: toolUseId,
    reason: "Classifier unavailable",
  }, env);
  assert.equal(denied.code, 0);

  // The log now holds exactly the two lines, written by the handlers themselves.
  const lines = await t.lines();
  assert.equal(lines.length, 2, `expected a gate line and a denial line, got ${JSON.stringify(lines)}`);
  assert.equal(lines[0].decision, "allow");
  assert.equal(lines[1].outcome, "denied-downstream");
  assert.equal(lines[0].toolUseId, lines[1].toolUseId, "the join key must survive both handlers");

  // 3. The real reporter reads that same file.
  const j = await run(status, "", { ...env, AUTOMEM_SYNAPSE_TEST_CLIENT: healthyClient })
    .then(({ stdout }) => JSON.parse(stdout));

  assert.equal(j.writeOutcomes.deniedDownstream, 1, "the denial must be joined to the gate's allow");
  assert.equal(j.writeOutcomes.unconfirmed, 0, "the write is known to have been refused, not unknown");
  assert.equal(j.writeOutcomes.allowed, 0, "it never reached AutoMem, so it is not an attempted write");
  assert.equal(j.writeOutcomes.failedDownstream, 0);
  assert.equal(j.writeOutcomes.orphanOutcomes, 0);
  assert.equal(j.writeOutcomes.uncorrelatable, 0, "both real handlers write the correlation key");

  // And the reason the handler bounded and recorded is the reason the reporter surfaces.
  assert.equal(j.lastDenial?.reason, "Classifier unavailable");
  assert.equal(j.lastDenial.toolUseId, toolUseId);
  assert.equal(j.lastFailure, null, "a denial is not a server fault, end to end");
});

test("a gate DENY and its own log line correlate to no downstream write at all", async () => {
  // The other half of the contract: a write the gate itself refuses never reaches AutoMem, so
  // no outcome hook fires for it and nothing may be invented. Run for real because the gate's
  // deny path writes a different record shape (`decision`, no `outcome`) than the allow path.
  const t = await withLog();
  const env = { AUTOMEM_CONFIG_PATH: t.cfgPath, AUTOMEM_API_KEY: "tok" };

  const gate = await run(preToolUse, {
    session_id: "s-e2e",
    hook_event_name: "PreToolUse",
    tool_name: "mcp__automem__store_memory",
    tool_input: { content: "api_key=abcdefghijklmnopqrstuvwx", type: "Decision", importance: 0.9 },
    tool_use_id: "toolu_01DENY",
  }, { ...env, AUTOMEM_SYNAPSE_TEST_CLIENT: emptyClient });
  assert.equal(JSON.parse(gate.stdout).hookSpecificOutput.permissionDecision, "deny");

  const j = await run(status, "", { ...env, AUTOMEM_SYNAPSE_TEST_CLIENT: healthyClient })
    .then(({ stdout }) => JSON.parse(stdout));
  assert.equal(j.writeOutcomes.allowed, 0);
  assert.equal(j.writeOutcomes.deniedDownstream, 0, "a gate deny is not an auto-mode denial");
  assert.equal(j.writeOutcomes.unconfirmed, 0);
  assert.equal(j.lastDenial, null, "lastDenial is about auto mode, not about the gate");
  assert.equal(j.lastFailure?.decision, "deny", "a gate deny does still register as lastFailure");
});
