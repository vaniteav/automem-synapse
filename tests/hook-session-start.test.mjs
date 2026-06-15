import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("../scripts/session-start.mjs", import.meta.url));
const mockClient = new URL("./fixtures/mock-client.mjs", import.meta.url).href; // file:// URL — Windows import() rejects raw C:\ paths

function run(input, env = {}) {
  return new Promise((resolve) => {
    const cp = execFile("node", [hook], { env: { ...process.env, ...env } }, (err, stdout) => resolve({ code: err?.code || 0, stdout }));
    cp.stdin.end(typeof input === "string" ? input : JSON.stringify(input)); // raw string ⇒ genuinely malformed stdin (JSON.stringify would make it valid)
  });
}

test("emits additionalContext on startup", async () => {
  const { stdout } = await run({ session_id: "s1", source: "startup", cwd: "C:/x" }, { AUTOMEM_SYNAPSE_TEST_CLIENT: mockClient, AUTOMEM_API_KEY: "tok" });
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /Found|memor|\[/);
});

test("malformed stdin fails safe (no output, exit 0)", async () => {
  const { code, stdout } = await run("not json", { AUTOMEM_SYNAPSE_TEST_CLIENT: mockClient });
  assert.equal(code, 0);
  assert.equal(stdout.trim(), "");
});
