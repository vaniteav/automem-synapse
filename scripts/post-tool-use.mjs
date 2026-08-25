import { loadConfig } from "./lib/config.mjs";
import { isWriteTool } from "./lib/write-tools.mjs";
import { boundForLog } from "./lib/bounded-text.mjs";
import { appendLog } from "./lib/log.mjs";
import { readStdin } from "./lib/runtime.mjs";

// WHY THIS HOOK EXISTS
// The PreToolUse gate logs `{decision:"allow"}` BEFORE the AutoMem write executes, and
// nothing logged what happened next. So a write that passed the gate and then failed
// downstream — timeout, 5xx, expired token — left a log that reads clean, and
// `/automem-status` reported `healthy: true` to someone whose memories were not saving.
// The gate's log line is a record of permission, not of persistence, and it was being read
// as both.
//
// DIVISION OF LABOUR: hooks log facts, `/automem-status` does the correlation. This script
// stays deliberately dumb — parse, narrow, append one line, exit. It holds no state, reads
// no prior log lines, and makes no network call. Joining "allowed" to "succeeded" is
// analysis, and analysis belongs in the reporter that a human explicitly ran, not in a hook
// that fires inside the agentic loop.
//
// PROCESS-SPAWN TRADE-OFF: `lib/session-cache.mjs` carries a standing argument against
// adding hook events casually — "every event is another process spawn on a plugin whose
// whole point is staying out of the way" — and that argument was accepted there, where
// SessionStart already ran and the work was free. It does not carry here, for one reason:
// these two events are wired to the SAME narrow AutoMem-write matcher as PreToolUse, not to
// every tool call. They fire only when the gate itself just fired, so the marginal cost is
// one extra short-lived node process per memory write (a handful per session), never per
// Read/Edit/Bash. Nothing else can supply the fact — the outcome is only observable at the
// moment the tool resolves.
//
// FAIL-SAFE: always exit 0, never write stdout. Per the Claude Code hooks reference these
// events cannot block ("Can block? No — the tool already ran / already failed"), so a
// non-zero exit or stray stdout is pure downside: exit 2 would surface this script's stderr
// to Claude as a warning about a tool that already completed, and stdout would be parsed for
// decision JSON. Same idiom as `session-start.mjs`: swallow everything, exit 0.

// The error string is bounded before it is logged, by the shared helper in
// `lib/bounded-text.mjs` (redact to finding kinds, else hard-cap) — see that file for the
// full rationale. Why it applies here specifically: verified against the hooks reference, the
// PostToolUseFailure `error` field is "generally the same text Claude receives as the failed
// tool's result", i.e. it is server-authored and can echo the request back — which for a
// store_memory failure means it can echo the memory content.

(async () => {
  try {
    const event = JSON.parse(await readStdin());
    const config = loadConfig();
    // Narrow by the CONFIGURED server name, exactly as the gate does. The hooks.json matcher
    // is deliberately server-agnostic (`mcp__.*__store_memory|…`) so a rename cannot fail it
    // open; the filtering to "our" server happens here.
    if (!isWriteTool(event.tool_name, config.mcpServerName)) return process.exit(0);
    const suffix = event.tool_name.slice(`mcp__${config.mcpServerName}__`.length);

    // Primary signal is `hook_event_name`, a documented common input field present on every
    // event. The `typeof event.error === "string"` fallback is belt-and-braces: only the
    // failure event carries a top-level `error`, so if the event name is ever absent or
    // renamed, an outcome record still lands on the correct side rather than recording a
    // failed write as a success — which is the exact failure mode this hook was added to end.
    const failed = event.hook_event_name === "PostToolUseFailure" || typeof event.error === "string";

    // Correlation key. Verified against the Claude Code hooks reference (2026-08-10):
    // `tool_use_id` is documented on PreToolUse, PostToolUse AND PostToolUseFailure, so the
    // join is an exact id match — no session + timestamp-proximity guessing needed.
    // `session` follows the naming the recall hooks already use.
    const record = {
      hook: failed ? "PostToolUseFailure" : "PostToolUse",
      tool: suffix,
      session: event.session_id,
      toolUseId: event.tool_use_id,
      outcome: failed ? "failure" : "success",
    };
    // `tool_response` is deliberately NOT logged, on success or failure: for a memory write
    // it is the stored record, i.e. the content itself.
    if (typeof event.duration_ms === "number") record.ms = event.duration_ms;
    if (failed) {
      record.error = boundForLog(event.error);
      if (event.is_interrupt === true) record.interrupted = true; // an abort, not a server fault
    }
    appendLog(config.observability.logFile, record);
    process.exit(0);
  } catch {
    process.exit(0); // fail-safe: an outcome record must never be able to disturb a session
  }
})();
