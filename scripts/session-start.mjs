import { loadConfig } from "./lib/config.mjs";
import { startupRecall } from "./lib/recall.mjs";
import { addInjectedIds } from "./lib/session-cache.mjs";
import { appendLog } from "./lib/log.mjs";
import { getClientFactory, readStdin } from "./lib/runtime.mjs";

(async () => {
  const start = Date.now();
  try {
    const event = JSON.parse(await readStdin());
    if (event.source && !["startup", "compact"].includes(event.source)) return process.exit(0);
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
