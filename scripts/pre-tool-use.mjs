import { loadConfig } from "./lib/config.mjs";
import { evaluateWritePolicy, evaluateEditPolicy } from "./lib/write-policy.mjs";
import { scanForSecrets } from "./lib/secret-scan.mjs";
import { parseSearchResults } from "./lib/recall.mjs";
import { appendLog } from "./lib/log.mjs";
import { isWriteTool } from "./lib/write-tools.mjs";
import { getClientFactory, readStdin } from "./lib/runtime.mjs";

function emit(decision, reason, updatedInput) {
  const hookSpecificOutput = { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason };
  if (updatedInput) hookSpecificOutput.updatedInput = updatedInput;
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
}
function toCandidate(input) {
  return { content: input.content, type: input.type || "Context", tags: input.tags || [], importance: input.importance, confidence: input.confidence, metadata: input.metadata, category: input.category };
}
// Log WHICH scanner rules fired, not just that one did. Kinds only — never the matched
// value, and never the content. Without this the log records "secret/privacy scanner found
// blocked content" and nothing else, so the false-positive rate of any individual rule is
// invisible; diagnosing the 2026-08-02 secret-assignment over-match required probing the
// scanner by hand because seven weeks of denials could not answer it.
function kindsOf(findings) {
  return Array.isArray(findings) && findings.length ? findings.map((f) => f.kind) : undefined;
}
// AutoMem write-tool fields we knowingly forward. Anything outside this allowlist is dropped
// rather than spread through unvetted (the scanner only inspects content/tags/metadata).
const EDIT_FIELDS = ["memory_id", "content", "type", "tags", "importance", "confidence", "metadata", "t_valid", "t_invalid", "embedding"];
const STORE_PASSTHROUGH = ["t_valid", "t_invalid", "embedding"]; // non-policed store fields kept as-is
function pick(obj, keys) {
  const out = {};
  if (obj) for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

(async () => {
  let config, suffix, corr = {};
  try {
    const event = JSON.parse(await readStdin());
    config = loadConfig();
    if (!isWriteTool(event.tool_name, config.mcpServerName)) return process.exit(0); // not ours: allow

    suffix = event.tool_name.slice(`mcp__${config.mcpServerName}__`.length);

    // Correlation key, spread into every log line below. Until this existed the gate logged
    // WHAT it decided but nothing that could tie the decision to the write it governed, so
    // the downstream outcome recorded by `post-tool-use.mjs` had nothing to join against and
    // `/automem-status` could only ever report gate-time denials.
    // `tool_use_id` is documented on PreToolUse, PostToolUse and PostToolUseFailure alike
    // (Claude Code hooks reference, verified 2026-08-10), so the join is an exact id match.
    // `session` alone would not do: a session issues many writes. `session` is carried
    // anyway — it is what makes a log line greppable per session, and it is the naming the
    // recall hooks already use.
    corr = { session: event.session_id, toolUseId: event.tool_use_id };

    // Mode "off" blocks ALL writes (store, update, delete, associate).
    if (config.writePolicy.mode === "off") {
      appendLog(config.observability.logFile, { hook: "PreToolUse", tool: suffix, ...corr, decision: "deny", reasons: ["write policy mode is off"] });
      emit("deny", "Blocked by automem-synapse: write policy mode is off");
      return process.exit(0);
    }

    // update_memory can carry user content/tags → run the EDIT policy (secrets + category),
    // but not the empty-content / min-importance / dedupe checks that only fit a fresh store.
    if (suffix === "update_memory") {
      const d = evaluateEditPolicy(toCandidate(event.tool_input || {}), config);
      if (d.action === "block") { appendLog(config.observability.logFile, { hook: "PreToolUse", tool: suffix, ...corr, decision: "deny", reasons: d.reasons, findings: kindsOf(d.findings) }); emit("deny", "Blocked by automem-synapse: " + d.reasons.join("; ")); return process.exit(0); }
      if (d.action === "confirm") { appendLog(config.observability.logFile, { hook: "PreToolUse", tool: suffix, ...corr, decision: "ask", reasons: d.reasons }); emit("ask", "Confirm edit: " + d.reasons.join("; ")); return process.exit(0); }
      appendLog(config.observability.logFile, { hook: "PreToolUse", tool: suffix, ...corr, decision: "allow" });
      emit("allow", "Vetted by automem-synapse (edit)", pick(event.tool_input, EDIT_FIELDS));
      return process.exit(0);
    }

    // delete_memory / associate_memories carry no policed content → secret-scan only.
    if (suffix !== "store_memory") {
      let meta = "";
      try { meta = JSON.stringify(event.tool_input?.metadata || {}); } catch { /* unserializable */ }
      const text = [event.tool_input?.content, ...(event.tool_input?.tags || []), meta].filter(Boolean).join("\n");
      const findings = scanForSecrets(text);
      if (findings.length) {
        appendLog(config.observability.logFile, { hook: "PreToolUse", tool: suffix, ...corr, decision: "deny", findings: findings.map((f) => f.kind) });
        emit("deny", `Blocked by automem-synapse: secret detected in ${suffix} payload`);
        return process.exit(0);
      }
      // Past here the payload is secret-clean — but that is ALL this gate checked, and
      // "no secrets in the arguments" is not an opinion about whether the operation is
      // wanted. `permissionDecision: "allow"` bypasses the permission prompt entirely,
      // so emitting it for delete_memory meant this plugin silently auto-approved a
      // destructive operation it had formed no view on.
      //
      // delete_memory  → say nothing. Exiting 0 with no hookSpecificOutput is the
      //   documented "no opinion" path (the same thing this script already does at the
      //   not-our-tool check) and hands the decision back to the normal permission flow.
      //   Chosen over emitting the newer `defer` enum value deliberately: identical
      //   semantics, no dependency on the host being new enough to know the value, and
      //   less code — this plugin's whole virtue is being small and fail-safe.
      // associate_memories → still allow. It is non-destructive, it links existing
      //   records, and its payload was scanned; adding a prompt there is friction with
      //   no risk behind it.
      if (suffix === "delete_memory") {
        appendLog(config.observability.logFile, { hook: "PreToolUse", tool: suffix, ...corr, decision: "no-opinion", reasons: ["destructive; gate only scanned for secrets"] });
        return process.exit(0);
      }
      appendLog(config.observability.logFile, { hook: "PreToolUse", tool: suffix, ...corr, decision: "allow" });
      emit("allow", "Vetted by automem-synapse (non-content write)");
      return process.exit(0);
    }

    // store_memory: full pipeline
    const candidate = toCandidate(event.tool_input || {});
    const decision = evaluateWritePolicy(candidate, config);

    if (decision.action === "block") {
      appendLog(config.observability.logFile, { hook: "PreToolUse", tool: suffix, ...corr, decision: "deny", reasons: decision.reasons, findings: kindsOf(decision.findings) });
      emit("deny", "Blocked by automem-synapse: " + decision.reasons.join("; "));
      return process.exit(0);
    }

    // dedupe (network; degrade gracefully on failure)
    if (config.writePolicy.dedupeBeforeWrite && candidate.content) {
      try {
        const createClient = await getClientFactory();
        const client = createClient({ url: config.server.url, token: config.server.token, timeoutMs: config.turnRecall.timeoutMs });
        const { text } = await client.recall(decision.normalized.content, { limit: 1 });
        const hit = parseSearchResults(text).find((m) => (m.score ?? 0) >= (config.writePolicy.dedupeMinScore ?? 0.85));
        if (hit) {
          appendLog(config.observability.logFile, { hook: "PreToolUse", tool: suffix, ...corr, decision: "ask", dup: hit.id });
          emit("ask", `Possible duplicate of memory ${hit.id}. Update it (mcp__${config.mcpServerName}__update_memory) instead, or confirm a new store.`);
          return process.exit(0);
        }
      } catch (e) {
        // dedupe degrades open (local policy already passed) but the degrade is recorded, not silent.
        appendLog(config.observability.logFile, { hook: "PreToolUse", tool: suffix, ...corr, dedupe: "degraded", error: String(e) });
      }
    }

    // Only "auto" is allowed silently. "confirm" and "propose" (safe-auto's
    // "confirm everything outside the auto categories") both require the user.
    if (decision.action === "confirm" || decision.action === "propose") {
      const lead = decision.action === "propose" ? "Not an auto-write category — confirm before storing: " : "Confirm before storing: ";
      appendLog(config.observability.logFile, { hook: "PreToolUse", tool: suffix, ...corr, decision: "ask", action: decision.action, reasons: decision.reasons });
      emit("ask", lead + decision.reasons.join("; "));
      return process.exit(0);
    }

    // auto → allow with transparent normalization. Carry ALL normalized fields:
    // AutoMem store takes content/type/tags/importance/metadata, so persist derived
    // source/category/confidence inside metadata rather than dropping them on the floor.
    const n = decision.normalized;
    const updated = {
      ...pick(event.tool_input, STORE_PASSTHROUGH), // only known AutoMem fields survive; unknown ones are dropped
      content: n.content, type: n.type, tags: n.tags, importance: n.importance,
      metadata: { ...(event.tool_input?.metadata || {}), source: n.source, category: n.category, confidence: n.confidence },
    };
    appendLog(config.observability.logFile, { hook: "PreToolUse", tool: suffix, ...corr, decision: "allow", normalized: true });
    emit("allow", "Vetted by automem-synapse", updated);
    process.exit(0);
  } catch (err) {
    // FAIL-CLOSED: never let an unvetted write through on error. Set the exit code
    // FIRST so the guarantee holds even if appendLog/emit themselves throw.
    process.exitCode = 2;
    try { appendLog(config?.observability?.logFile, { hook: "PreToolUse", tool: suffix, ...corr, decision: "deny", error: String(err) }); } catch { /* ignore */ }
    try { emit("deny", "automem-synapse gate error (fail-closed): " + String(err)); } catch { /* ignore */ }
    process.exit(2);
  }
})();
