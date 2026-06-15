import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("../../scripts/pre-tool-use.mjs", import.meta.url));

test("live: gate runs dedupe against the real sidecar and reaches a decision", { skip: !process.env.AUTOMEM_API_KEY }, async () => {
  const input = { session_id: "smoke", tool_name: "mcp__automem__store_memory", tool_input: { content: "automem-synapse smoke probe " + Date.now(), type: "Context", tags: ["smoke"], importance: 0.9 } };
  const { code, stdout } = await new Promise((resolve) => {
    const cp = execFile("node", [hook], { env: process.env }, (err, stdout) => resolve({ code: err?.code || 0, stdout }));
    cp.stdin.end(JSON.stringify(input));
  });
  assert.equal(code, 0); // not fail-closed: live dedupe degraded or passed
  const decision = JSON.parse(stdout).hookSpecificOutput.permissionDecision;
  assert.ok(["allow", "ask"].includes(decision)); // benign content → allow, or ask if a near-dup exists
});
