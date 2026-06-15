import { loadConfig } from "./lib/config.mjs";
import { turnRecall } from "./lib/recall.mjs";
import { detectProject } from "./lib/project-detect.mjs";
import { getInjectedIds, addInjectedIds } from "./lib/session-cache.mjs";
import { appendLog } from "./lib/log.mjs";
import { getClientFactory, readStdin } from "./lib/runtime.mjs";

(async () => {
  const start = Date.now();
  try {
    const event = JSON.parse(await readStdin());
    const prompt = (event.prompt || "").trim();
    if (!prompt) return process.exit(0);
    const config = loadConfig();
    if (!config.server.token) return process.exit(0);
    const project = detectProject(event.cwd, prompt, config);
    const createClient = await getClientFactory();
    const client = createClient({ url: config.server.url, token: config.server.token, timeoutMs: config.turnRecall.timeoutMs });
    const exclude = new Set(getInjectedIds(event.session_id));
    const result = await turnRecall(client, prompt, project, config, exclude);
    if (!result.text) return process.exit(0);
    addInjectedIds(event.session_id, result.ids);
    appendLog(config.observability.logFile, { hook: "UserPromptSubmit", session: event.session_id, project: project.projectTag, count: result.count, bytes: Buffer.byteLength(result.text), ms: Date.now() - start });
    const label = project.projectLabel ? ` [${project.projectLabel}]` : "";
    process.stdout.write(`Relevant memories${label}:\n${result.text}\n`);
    process.exit(0);
  } catch {
    process.exit(0); // fail-safe
  }
})();
