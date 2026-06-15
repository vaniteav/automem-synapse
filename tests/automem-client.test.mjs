import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createAutomemClient } from "../scripts/lib/automem-client.mjs";

function mockServer(handler) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => handler(JSON.parse(body || "{}"), res));
    });
    srv.listen(0, () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/mcp` }));
  });
}

test("recall() performs initialize then tools/call and returns text", async () => {
  const { srv, url } = await mockServer((msg, res) => {
    if (msg.method === "initialize") {
      res.setHeader("Mcp-Session-Id", "sess-1");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { serverInfo: { name: "mock" } } }));
    } else if (msg.method === "notifications/initialized") {
      res.statusCode = 202; res.end();
    } else if (msg.method === "tools/call") {
      assert.equal(msg.params.name, "recall_memory");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "Found 1 memories:\n\n1. hi [t] score=0.9\n   ID: z" }] } }));
    }
  });
  const client = createAutomemClient({ url, token: "tok", timeoutMs: 3000 });
  const { text } = await client.recall("q", { limit: 1 });
  assert.match(text, /Found 1 memories/);
  srv.close();
});

test("recall() parses SSE-framed tool result", async () => {
  const { srv, url } = await mockServer((msg, res) => {
    if (msg.method === "initialize") { res.setHeader("Mcp-Session-Id", "s"); res.setHeader("Content-Type","application/json"); res.end(JSON.stringify({ jsonrpc:"2.0", id: msg.id, result:{} })); }
    else if (msg.method === "notifications/initialized") { res.statusCode = 202; res.end(); }
    else { res.setHeader("Content-Type", "text/event-stream"); res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc:"2.0", id: msg.id, result:{ content:[{type:"text", text:"Found 0 memories:"}] } })}\n\n`); }
  });
  const client = createAutomemClient({ url, token: "tok", timeoutMs: 3000 });
  const { text } = await client.recall("q", {});
  assert.match(text, /Found 0 memories/);
  srv.close();
});

test("recall() rejects when initialize returns a JSON-RPC error", async () => {
  const { srv, url } = await mockServer((msg, res) => {
    res.setHeader("Content-Type", "application/json");
    if (msg.method === "initialize") res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "nope" } }));
    else res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
  });
  const client = createAutomemClient({ url, token: "tok", timeoutMs: 3000 });
  await assert.rejects(() => client.recall("q", {}), /initialize failed/);
  srv.close();
});

test("concurrent recalls initialize the session only once", async () => {
  let initCount = 0;
  const { srv, url } = await mockServer((msg, res) => {
    if (msg.method === "initialize") { initCount++; res.setHeader("Mcp-Session-Id", "s"); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} })); }
    else if (msg.method === "notifications/initialized") { res.statusCode = 202; res.end(); }
    else { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "Found 0 memories:" }] } })); }
  });
  const client = createAutomemClient({ url, token: "tok", timeoutMs: 3000 });
  await Promise.all([client.recall("a", {}), client.recall("b", {}), client.recall("c", {})]);
  assert.equal(initCount, 1, `initialize should run once, ran ${initCount} times`);
  srv.close();
});

test("recall() reassembles a multi-line SSE data payload", async () => {
  const { srv, url } = await mockServer((msg, res) => {
    if (msg.method === "initialize") { res.setHeader("Mcp-Session-Id", "s"); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} })); }
    else if (msg.method === "notifications/initialized") { res.statusCode = 202; res.end(); }
    else {
      const pretty = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "Found 2 memories:" }] } }, null, 2);
      const sse = pretty.split("\n").map((l) => "data: " + l).join("\n"); // genuine multi-line SSE data
      res.setHeader("Content-Type", "text/event-stream");
      res.end(`event: message\n${sse}\n\n`);
    }
  });
  const client = createAutomemClient({ url, token: "tok", timeoutMs: 3000 });
  const { text } = await client.recall("q", {});
  assert.match(text, /Found 2 memories/);
  srv.close();
});
