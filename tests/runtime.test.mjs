import { test } from "node:test";
import assert from "node:assert/strict";
import { getClientFactory, readStdin } from "../scripts/lib/runtime.mjs";

const mockClient = new URL("./fixtures/mock-client.mjs", import.meta.url).href;

test("getClientFactory returns the injected test client when env is set", async () => {
  const prev = process.env.AUTOMEM_SYNAPSE_TEST_CLIENT;
  process.env.AUTOMEM_SYNAPSE_TEST_CLIENT = mockClient;
  try {
    const factory = await getClientFactory();
    const client = factory({});
    const { text } = await client.recall("q", {});
    assert.match(text, /mock memory/);
  } finally {
    if (prev === undefined) delete process.env.AUTOMEM_SYNAPSE_TEST_CLIENT; else process.env.AUTOMEM_SYNAPSE_TEST_CLIENT = prev;
  }
});

test("getClientFactory falls back to the real client factory", async () => {
  const prev = process.env.AUTOMEM_SYNAPSE_TEST_CLIENT;
  delete process.env.AUTOMEM_SYNAPSE_TEST_CLIENT;
  try {
    const factory = await getClientFactory();
    assert.equal(typeof factory, "function");
    const client = factory({ url: "http://x/mcp", token: "t" });
    assert.equal(typeof client.recall, "function");
    assert.equal(typeof client.health, "function");
  } finally {
    if (prev !== undefined) process.env.AUTOMEM_SYNAPSE_TEST_CLIENT = prev;
  }
});

test("readStdin is exported as a function", () => {
  assert.equal(typeof readStdin, "function");
});
