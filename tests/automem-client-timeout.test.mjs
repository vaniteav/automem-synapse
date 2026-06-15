import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createAutomemClient } from "../scripts/lib/automem-client.mjs";

// A recall does initialize + notify + tools/call. timeoutMs must be a budget for the
// WHOLE recall, not a fresh per-RPC timeout — otherwise a slow init + a hung call can
// run for ~2x timeoutMs and outlive the hook timeout.
test("recall() is bounded by ~timeoutMs total across init + call, not per-RPC", async () => {
  const handler = (msg, res) => {
    if (msg.method === "initialize") {
      setTimeout(() => {
        res.setHeader("Mcp-Session-Id", "s");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
      }, 200); // slow init eats into the budget
    } else if (msg.method === "notifications/initialized") {
      res.statusCode = 202; res.end();
    } else {
      /* tools/call: never respond — force the client to abort at its deadline */
    }
  };
  const { srv, url } = await new Promise((resolve) => {
    const s = createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => handler(JSON.parse(b || "{}"), res)); });
    s.listen(0, () => resolve({ srv: s, url: `http://127.0.0.1:${s.address().port}/mcp` }));
  });

  const client = createAutomemClient({ url, token: "tok", timeoutMs: 400 });
  const t0 = Date.now();
  await assert.rejects(() => client.recall("q", { limit: 1 }));
  const elapsed = Date.now() - t0;
  srv.closeAllConnections?.();
  srv.close();
  assert.ok(elapsed < 520, `recall should abort within ~one budget (~400ms), took ${elapsed}ms`);
  assert.ok(elapsed > 250, `should have used roughly the full budget, took ${elapsed}ms`);
});
