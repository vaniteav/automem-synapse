import { loadConfig } from "./lib/config.mjs";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { getClientFactory } from "./lib/runtime.mjs";

function tailLog(file) {
  try {
    const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const last = lines[lines.length - 1] || null;
    const lastFailure = [...lines].reverse().find((l) => l.error || l.decision === "deny") || null;
    return { last, lastFailure };
  } catch { return { last: null, lastFailure: null }; }
}
async function preToolUseMatcher() {
  try {
    const h = JSON.parse(await readFile(new URL("../hooks/hooks.json", import.meta.url), "utf8"));
    return h.hooks?.PreToolUse?.[0]?.matcher || "";
  } catch { return ""; }
}
// Drift check: does the configured server's write tool actually trigger the matcher?
// Tests the matcher directly rather than parsing a server name out of it, so it stays
// correct for a server-agnostic (mcp__.*__) matcher and for any rename.
function matcherFires(matcher, serverName) {
  if (!matcher) return false;
  try { return new RegExp(matcher).test(`mcp__${serverName}__store_memory`); } catch { return false; }
}

(async () => {
  const config = loadConfig();
  let healthy = false, status = 0, memoryCount = null;
  try {
    const createClient = await getClientFactory();
    const client = createClient({ url: config.server.url, token: config.server.token, timeoutMs: 8000 });
    const h = await client.health();
    healthy = h.ok; status = h.status;
    memoryCount = h.body?.memory_count ?? h.body?.count ?? h.body?.memories ?? null;
  } catch { /* report unhealthy */ }
  const { last, lastFailure } = tailLog(config.observability.logFile);
  const matcher = await preToolUseMatcher();
  const matcherMismatch = matcherFires(matcher, config.mcpServerName)
    ? null
    : `WARNING: hooks.json PreToolUse matcher does not fire for "mcp__${config.mcpServerName}__store_memory" — the write gate will NOT run for server "${config.mcpServerName}". Edit hooks/hooks.json.`;
  process.stdout.write(JSON.stringify({
    healthy, status, memoryCount,
    serverUrl: config.server.url,
    tokenPresent: !!config.server.token,
    mcpServerName: config.mcpServerName,
    matcherMismatch,
    writePolicyMode: config.writePolicy.mode,
    startupRecall: config.startupRecall.enabled,
    turnRecall: config.turnRecall.enabled,
    lastHookResult: last,
    lastFailure,
    logFile: config.observability.logFile,
  }, null, 2));
})();
