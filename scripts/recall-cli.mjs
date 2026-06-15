import { loadConfig } from "./lib/config.mjs";
import { getClientFactory } from "./lib/runtime.mjs";

(async () => {
  const query = process.argv.slice(2).join(" ").trim();
  if (!query) { process.stdout.write("Usage: recall-cli <query>\n"); return; }
  const config = loadConfig();
  try {
    const createClient = await getClientFactory();
    const client = createClient({ url: config.server.url, token: config.server.token, timeoutMs: config.startupRecall.timeoutMs });
    const { text } = await client.recall(query, { limit: config.turnRecall.limit });
    process.stdout.write(text || "No memories found.\n");
  } catch (e) { process.stdout.write("Recall failed: " + String(e) + "\n"); }
})();
