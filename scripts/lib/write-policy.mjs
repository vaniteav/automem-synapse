// Ported/adapted from pi-automem-bridge/src/write-policy.ts
import { scanForSecrets } from "./secret-scan.mjs";

const VALID_TYPES = new Set(["Decision", "Pattern", "Preference", "Style", "Habit", "Insight", "Context"]);

export function normalizeCandidate(input, config) {
  const wp = config.writePolicy || {};
  const tags = Array.from(new Set([
    ...(wp.alwaysTag || []),
    ...(input.tags || []),
  ].map((t) => String(t).trim().toLowerCase()).filter(Boolean)));

  return {
    content: String(input.content || "").replace(/\s+/g, " ").trim(),
    type: input.type,
    tags,
    importance: clampNumber(input.importance, 0, 1, defaultImportanceForType(input.type)),
    confidence: clampNumber(input.confidence, 0, 1, 0.9),
    source: input.source || wp.defaultSource || "claude-code-session",
    category: (input.category || inferCategory(input.type, tags)).toLowerCase(),
    metadata: input.metadata,
  };
}

export function evaluateWritePolicy(input, config) {
  const wp = config.writePolicy || {};
  const beh = config.behavior || {};
  const normalized = normalizeCandidate(input, config);
  const reasons = [];

  let metadataText = "";
  if (normalized.metadata) {
    try { metadataText = "\n" + JSON.stringify(normalized.metadata); } catch { /* unserializable */ }
  }
  const findings = scanForSecrets(normalized.content + "\n" + normalized.tags.join("\n") + metadataText);
  const mode = wp.mode || "propose";
  const preferredMax = beh.preferredContentLength || 500;
  const hardMax = beh.maxContentLength || 2000;
  const minImportance = Number(wp.minImportanceToWrite ?? 0.7);

  if (mode === "off") reasons.push("write policy mode is off");
  if (!normalized.content) reasons.push("content is empty");
  if (!VALID_TYPES.has(normalized.type)) reasons.push("invalid memory type");
  if (normalized.content.length > hardMax) reasons.push("content exceeds hard length limit");
  if (findings.length > 0) reasons.push("secret/privacy scanner found blocked content");
  if (normalized.importance < minImportance) reasons.push("importance is below configured write threshold");
  if (isBlockedCategory(normalized, wp)) reasons.push("category is blocked by write policy");

  if (reasons.length > 0) return { action: "block", reasons, advisories: [], findings, normalized };

  // Advisories are informational, never gating — kept separate so they don't read as
  // reasons-to-confirm in the user-facing prompt.
  const advisories = [];
  if (normalized.content.length > preferredMax) {
    advisories.push("content exceeds preferred embedding length; consider shortening");
  }
  if (mode === "confirm-all") return { action: "confirm", reasons: ["write policy requires confirmation for all"], advisories, findings, normalized };
  if (isConfirmCategory(normalized, wp)) return { action: "confirm", reasons: ["category requires confirmation"], advisories, findings, normalized };
  if (mode === "safe-auto" && isAutoCategory(normalized, wp)) return { action: "auto", reasons: ["eligible for safe automatic write"], advisories, findings, normalized };
  return { action: "propose", reasons: ["candidate should be proposed before storing"], advisories, findings, normalized };
}

// Lighter gate for edits (update_memory): secrets + blocked/confirm category only.
// Skips the empty-content / min-importance / dedupe checks that only fit a fresh store.
export function evaluateEditPolicy(input, config) {
  const wp = config.writePolicy || {};
  const beh = config.behavior || {};
  if (wp.mode === "off") return { action: "block", reasons: ["write policy mode is off"], findings: [] };
  const tags = (input.tags || []).map((t) => String(t).trim().toLowerCase());
  const norm = { ...input, tags, category: (input.category || inferCategory(input.type || "Context", tags)).toLowerCase() };
  let metadataText = "";
  if (input.metadata) { try { metadataText = "\n" + JSON.stringify(input.metadata); } catch { /* unserializable */ } }
  // Serialize non-string content so neither the secret scan nor the length cap can be
  // bypassed by passing content as an object/array (which would also be forwarded raw on the
  // update allow-path). null/undefined → "" (omitting content is valid for an edit).
  const contentStr = typeof input.content === "string" ? input.content
    : input.content == null ? "" : safeStringify(input.content);
  const findings = scanForSecrets(contentStr + "\n" + tags.join("\n") + metadataText);
  if (findings.length > 0) return { action: "block", reasons: ["secret/privacy scanner found blocked content"], findings };
  // Same hard length cap the store path enforces — an edit must not be a back door around it.
  if (contentStr.length > (beh.maxContentLength || 2000)) {
    return { action: "block", reasons: ["content exceeds hard length limit"], findings };
  }
  if (isBlockedCategory(norm, wp)) return { action: "block", reasons: ["category is blocked by write policy"], findings };
  if (wp.mode === "confirm-all" || isConfirmCategory(norm, wp)) return { action: "confirm", reasons: ["edit requires confirmation"], findings };
  return { action: "allow", reasons: [], findings };
}

function isBlockedCategory(c, wp) {
  const s = new Set((wp.blockedCategories || []).map((x) => x.toLowerCase()));
  return s.has(c.category || "") || c.tags.some((t) => s.has(t));
}
function isConfirmCategory(c, wp) {
  const s = new Set((wp.confirmCategories || []).map((x) => x.toLowerCase()));
  return s.has(c.category || "") || c.tags.some((t) => s.has(t));
}
function isAutoCategory(c, wp) {
  const s = new Set((wp.autoWriteCategories || []).map((x) => x.toLowerCase()));
  return s.has(c.category || "") || s.has(c.type.toLowerCase()) || c.tags.some((t) => s.has(t));
}
function inferCategory(type, tags) {
  if (tags.includes("preference")) return "preference";
  if (tags.includes("decision")) return "technical-decision";
  if (tags.includes("bug-fix")) return "bug-fix";
  if (tags.includes("pattern")) return "agent-pattern";
  if (tags.includes("private") || tags.includes("personal")) return "private";
  switch (type) {
    case "Decision": return "technical-decision";
    case "Preference": return "preference";
    case "Pattern": return "agent-pattern";
    case "Insight": return "tooling-lesson";
    default: return "context";
  }
}
function defaultImportanceForType(type) {
  switch (type) {
    case "Decision": return 0.9;
    case "Preference": return 0.85;
    case "Pattern": return 0.8;
    case "Insight": return 0.8;
    case "Style": return 0.7;
    case "Habit": return 0.65;
    case "Context": return 0.6;
    default: return 0.5;
  }
}
function safeStringify(value) {
  try { return JSON.stringify(value) ?? String(value); }
  catch { return String(value); } // circular/unserializable → still a non-empty string for scanning
}
function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
