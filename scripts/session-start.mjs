import { loadConfig } from "./lib/config.mjs";
import { startupRecall } from "./lib/recall.mjs";
import { addInjectedIds, pruneOldSessions } from "./lib/session-cache.mjs";

// A session's injected-id list is only meaningful while that session is alive. Seven days
// is deliberately generous — the cost of keeping one too long is a few hundred bytes, the
// cost of dropping one early is a duplicate memory injection.
const SESSION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
import { appendLog } from "./lib/log.mjs";
import { getClientFactory, readStdin } from "./lib/runtime.mjs";

(async () => {
  const start = Date.now();
  try {
    const event = JSON.parse(await readStdin());
    // Sweep stale session caches before any early return below. Deliberately placed ahead
    // of the source filter and the token check: those exit for resume/fork and for an
    // unconfigured install, and stale files need collecting in exactly those cases too.
    // Needs no config and cannot throw (see pruneOldSessions).
    pruneOldSessions(SESSION_CACHE_TTL_MS);
    // Recall only where context does NOT already carry it: startup (empty), clear
    // (wiped), compact (may have dropped the block). resume/fork inherit the prior
    // transcript, so re-injecting there would duplicate memories already present.
    if (event.source && !["startup", "clear", "compact"].includes(event.source)) return process.exit(0);
    const config = loadConfig();
    if (!config.server.token) return process.exit(0);
    const createClient = await getClientFactory();
    const client = createClient({ url: config.server.url, token: config.server.token, timeoutMs: config.startupRecall.timeoutMs });
    const result = await startupRecall(client, config);
    if (!result.text) return process.exit(0);
    addInjectedIds(event.session_id, result.ids);
    appendLog(config.observability.logFile, { hook: "SessionStart", session: event.session_id, count: result.count, bytes: Buffer.byteLength(result.text), ms: Date.now() - start });
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: result.text } }));
    process.exit(0);
  } catch {
    process.exit(0); // fail-safe: recall must never block a session
  }
})();
