import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULTS = {
  mcpServerName: "automem",
  server: { url: "https://mcp-automem-production-650a.up.railway.app/mcp", tokenEnv: "AUTOMEM_API_KEY", token: "" },
  startupRecall: { enabled: true, queries: ["user preferences working style", "current environment", "active projects and recent decisions"], tags: [], tagMode: "any", limit: 5, maxBytes: 4000, timeoutMs: 12000 },
  turnRecall: { enabled: true, limit: 5, maxBytes: 3000, timeoutMs: 7000, contextTypes: [], expandRelations: false, expandEntities: false },
  projectDetection: {},
  projectOverrides: {},
  writePolicy: {
    mode: "safe-auto",
    autoWriteCategories: ["technical-decision", "agent-pattern", "bug-fix", "tooling-lesson"],
    confirmCategories: ["personal", "financial", "private", "identity"],
    blockedCategories: ["secret", "credential", "api-key", "raw-transcript"],
    minImportanceToWrite: 0.7,
    dedupeBeforeWrite: true,
    dedupeMinScore: 0.85,
    alwaysTag: ["agent:claude-code"],
    defaultSource: "claude-code-session",
  },
  behavior: { preferredContentLength: 500, maxContentLength: 2000 },
  observability: { logFile: join(homedir(), ".claude", "automem-synapse.log") },
};

export function defaultConfigPath() {
  return process.env.AUTOMEM_CONFIG_PATH || join(homedir(), ".claude", "automem-synapse.json");
}

function mergeSection(def, user) {
  // Always return a fresh object — never hand back the shared DEFAULTS reference,
  // or later `cfg.server.token = …` would mutate DEFAULTS across calls.
  return { ...def, ...(user && typeof user === "object" && !Array.isArray(user) ? user : {}) };
}

export function loadConfig(path = defaultConfigPath()) {
  let user = {};
  try { user = JSON.parse(readFileSync(path, "utf8")); } catch { user = {}; }
  const cfg = {
    mcpServerName: user.mcpServerName || DEFAULTS.mcpServerName,
    server: mergeSection(DEFAULTS.server, user.server),
    startupRecall: mergeSection(DEFAULTS.startupRecall, user.startupRecall),
    turnRecall: mergeSection(DEFAULTS.turnRecall, user.turnRecall),
    projectDetection: mergeSection(DEFAULTS.projectDetection, user.projectDetection),
    projectOverrides: mergeSection(DEFAULTS.projectOverrides, user.projectOverrides),
    writePolicy: mergeSection(DEFAULTS.writePolicy, user.writePolicy),
    behavior: mergeSection(DEFAULTS.behavior, user.behavior),
    observability: mergeSection(DEFAULTS.observability, user.observability),
  };
  const tokenEnv = cfg.server.tokenEnv || "AUTOMEM_API_KEY";
  cfg.server.token = process.env[tokenEnv] || cfg.server.token || "";
  return cfg;
}
