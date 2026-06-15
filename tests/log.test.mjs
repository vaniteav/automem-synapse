import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLog } from "../scripts/lib/log.mjs";

test("appends a JSONL line with a timestamp", async () => {
  const dir = await mkdtemp(join(tmpdir(), "amsyn-log-"));
  const f = join(dir, "x.log");
  appendLog(f, { hook: "PreToolUse", decision: "deny" });
  const line = (await readFile(f, "utf8")).trim();
  const obj = JSON.parse(line);
  assert.equal(obj.hook, "PreToolUse");
  assert.equal(obj.decision, "deny");
  assert.equal(typeof obj.ts, "string");
});

test("never throws on a bad path", () => {
  assert.doesNotThrow(() => appendLog("C:/nonexistent-dir-xyz/no.log", { a: 1 }));
});
