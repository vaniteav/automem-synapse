import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const hook = fileURLToPath(new URL("../scripts/user-prompt-submit.mjs", import.meta.url));
const mockClient = new URL("./fixtures/mock-client.mjs", import.meta.url).href; // file:// URL — Windows import() rejects raw C:\ paths

function run(input, env = {}) {
  return new Promise((resolve) => {
    const cp = execFile("node", [hook], { env: { ...process.env, ...env } }, (err, stdout) => resolve({ code: err?.code || 0, stdout }));
    cp.stdin.end(JSON.stringify(input));
  });
}

test("prints per-turn recall to stdout", async () => {
  // Unique session id per run: the session-cache persists to the OS temp dir, and a
  // reused id would dedup-exclude the only mock memory on the second run.
  const { stdout } = await run({ session_id: randomUUID(), prompt: "work on the gate", cwd: "C:/x" }, { AUTOMEM_SYNAPSE_TEST_CLIENT: mockClient, AUTOMEM_API_KEY: "tok" });
  assert.match(stdout, /mock memory|\[/);
});

test("empty prompt produces no output", async () => {
  const { stdout } = await run({ session_id: "s9", prompt: "", cwd: "C:/x" }, { AUTOMEM_SYNAPSE_TEST_CLIENT: mockClient, AUTOMEM_API_KEY: "tok" });
  assert.equal(stdout.trim(), "");
});
