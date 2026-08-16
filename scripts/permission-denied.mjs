import { loadConfig } from "./lib/config.mjs";
import { isWriteTool } from "./lib/write-tools.mjs";
import { boundForLog } from "./lib/bounded-text.mjs";
import { appendLog } from "./lib/log.mjs";
import { readStdin } from "./lib/runtime.mjs";

// WHY THIS HOOK EXISTS
// The PreToolUse gate emits `permissionDecision: "allow"` and logs `{decision:"allow"}` at
// three sites in `pre-tool-use.mjs`. That line says the gate formed no objection — it does
// NOT say the tool call ran. In auto mode Claude Code's own classifier can deny the call
// afterwards, and when it does neither PostToolUse nor PostToolUseFailure fires, so nothing
// was logged at all. The write vanished between "allowed" and "resolved", and
// `/automem-status` had no line to read: it filed the write as allowed-but-unconfirmed, the
// bucket that otherwise means "in flight, or silently broken". The reporter even hard-coded
// the contrary assumption in a comment — "`allow` always runs, so silence there really does
// mean in-flight" — which was simply wrong. This hook supplies the missing line.
//
// SCOPE LIMIT — AUTO MODE ONLY. Per the hooks reference (verified 2026-08-16), PermissionDenied
// "only fires in auto mode: it doesn't run when you manually deny a permission dialog, when a
// PreToolUse hook blocks a call, or when a `deny` rule matches". So this narrows the blind
// spot rather than closing it: a user who denies the confirmation dialog by hand still leaves
// no trace, and that write still lands in `unconfirmed`. The gate's own denials are already
// logged by `pre-tool-use.mjs`, and a `deny` permission rule is the user's standing
// configuration rather than an event about this write — neither is a gap. The one gap this
// closes is the one a user cannot see coming, because nothing in the session surfaces it.
//
// OBSERVABILITY ONLY — NO `retry`. The hooks reference gives this event exactly one lever:
// `hookSpecificOutput.retry: true`, which tells the model it may retry the denied call (it
// does not reverse the denial). We deliberately do not use it. A plugin that silently
// re-prompts the model to retry an action the user's own safety layer just denied is arguing
// with the permission system on the user's behalf, and this plugin's entire posture — a
// fail-closed gate, `no-opinion` for destructive deletes — is the opposite of that. Recording
// the denial is the whole ask. Consequently this script writes nothing to stdout, and always
// exits 0: for this event the reference states "exit code and stderr are ignored because the
// denial already occurred", so a non-zero exit or stray stderr is pure noise with no effect.
//
// WHY THE NARROW WRITE MATCHER. Wired in `hooks.json` to the SAME AutoMem-write matcher as
// PreToolUse/PostToolUse/PostToolUseFailure, not to every tool. Two reasons. First cost: the
// standing objection in `lib/session-cache.mjs` — "every event is another process spawn on a
// plugin whose whole point is staying out of the way" — only fails to bite because this fires
// on memory writes, a handful per session, never on Read/Edit/Bash. Second correctness: the
// record only has value because `/automem-status` can join it by `toolUseId` to a gate line,
// and the gate only ever produced lines for AutoMem writes. A denial of some unrelated Bash
// command is real, but it is Claude Code's business to report, not this plugin's.
//
// DIVISION OF LABOUR, as with the other outcome hook: this script parses, narrows, appends one
// line and exits. No state, no prior-log reads, no network. Correlation happens in
// `/automem-status`, a reporter a human explicitly ran.

(async () => {
  try {
    const event = JSON.parse(await readStdin());
    const config = loadConfig();
    // Narrow by the CONFIGURED server name, exactly as the gate and the outcome recorder do,
    // via the shared `isWriteTool` — a tool list that drifted between the two sides of a join
    // would miscount silently rather than fail.
    if (!isWriteTool(event.tool_name, config.mcpServerName)) return process.exit(0);
    const suffix = event.tool_name.slice(`mcp__${config.mcpServerName}__`.length);

    // `tool_use_id` is documented on PermissionDenied as it is on PreToolUse, so the join back
    // to the gate's `allow` line is an exact id match, same as the success/failure records.
    const record = {
      hook: "PermissionDenied",
      tool: suffix,
      session: event.session_id,
      toolUseId: event.tool_use_id,
      outcome: "denied-downstream",
    };
    // `tool_input` is deliberately NOT logged — for a memory write it is the content itself,
    // the same reason `tool_response` is never logged on the success path.
    //
    // `reason` is the host's denial text: usually the fixed string "Blocked by classifier",
    // sometimes the classifier's own written explanation, sometimes "Classifier unavailable"
    // or a string beginning "Auto mode could not evaluate this action…". There is no
    // structured verdict field to record instead, and an explanation written about this tool
    // call can quote the tool call, so it goes through the same bounding as a failure's error.
    const reason = boundForLog(event.reason);
    if (reason !== undefined) record.reason = reason;
    appendLog(config.observability.logFile, record);
    process.exit(0);
  } catch {
    process.exit(0); // fail-safe: a denial record must never be able to disturb a session
  }
})();
