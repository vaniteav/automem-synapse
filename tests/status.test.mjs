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
