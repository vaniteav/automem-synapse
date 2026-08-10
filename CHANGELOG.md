# Changelog

## 2026-08-10 — unreleased
- **A write that passed the gate and then failed left no trace.** `PreToolUse` logs `{decision:"allow"}` *before* the AutoMem write executes, and nothing logged what happened next — so a timeout, a 5xx, or an expired token produced a log that reads clean, and `/automem-status` answered "my memories aren't saving" with `healthy: true`. The gate's line records permission, not persistence; it was being read as both. `PostToolUse` and `PostToolUseFailure` now record what each gated write actually did, and `/automem-status` reports confirmed / failed-downstream / allowed-but-never-confirmed.
- **Hooks log facts; `/automem-status` does the correlation.** `scripts/post-tool-use.mjs` parses, narrows, appends one line and exits — no state, no prior-log reads, no network. Joining "allowed" to "succeeded" is analysis, and analysis belongs in a reporter a human explicitly ran, not in a hook firing inside the agentic loop. It always exits 0 and writes nothing to stdout, including on malformed stdin: per the hooks reference these events cannot block, so a non-zero exit or stray stdout is pure downside.
- **The correlation key had to be added to the gate first.** The gate read only `tool_name` and `tool_input`; it logged *what* it decided but nothing that could tie the decision to the write it governed, so an outcome record would have had nothing to join against. Every gate log line now carries `session` and `toolUseId`. `tool_use_id` is documented on `PreToolUse`, `PostToolUse` and `PostToolUseFailure` alike (verified against the hooks reference, 2026-08-10), so the join is an exact id match rather than session + timestamp-proximity guessing. Lines written before this carry no key: they are counted and surfaced as `uncorrelatable`, never folded into `unconfirmed` — degrading an old log to "unknown" is honest, degrading it to "broken" is not.
- **Two new hook events, against the standing objection.** `session-cache.mjs` argues that "every event is another process spawn on a plugin whose whole point is staying out of the way", and that argument was accepted there. It does not carry here: both events are wired to the *same narrow AutoMem-write matcher* as the gate, not to every tool call, so the cost is one short-lived node process per memory write — a handful per session, never per Read/Edit/Bash. Nothing else can supply the fact; the outcome is only observable at the moment the tool resolves. The tool-set narrowing now lives in one place (`lib/write-tools.mjs`) shared by both hooks, because if the two ever drifted the correlation would not fail loudly — it would quietly miscount forever.
- **Error strings are bounded before they are logged.** The `PostToolUseFailure` `error` field is server-authored and is generally the text Claude receives as the failed tool's result, so a `store_memory` failure can echo the memory content back. Consistent with the gate's stance of logging kinds, never values: if the repo's own secret scanner fires on the error it is replaced by its finding kinds, otherwise it is hard-capped at 200 characters. The cap bounds leakage rather than eliminating it — the head of the string is where the status code lives, and an error field with nothing diagnostic in it would not have caught the failure this entry is about. `tool_response` is never logged at all.
- `/automem-status` no longer reads the whole log file. It was an unbounded read that grew for the life of the install, to answer a question about the recent past; it now reads at most the last 256 KiB and correlates at most the last 200 records, with the window size reported so its boundary is visible rather than implied.

## 2026-08-02 — unreleased maintenance
- **Recall now fires after `/clear`.** `SessionStart` matched only `startup|compact`, so clearing the context wiped the injected memories and nothing re-injected them — the one session source where context is empty but recall never ran. `resume` and `fork` remain deliberately excluded: both inherit the prior transcript, so recall there would duplicate memories already present.
- The source allow-list is enforced in two places (`hooks/hooks.json` matcher and the runtime guard in `scripts/session-start.mjs`); both are now covered by tests, so changing one without the other fails instead of silently dropping a source.
- Verified against the current Claude Code `SessionStart` matcher set (`startup`, `resume`, `clear`, `compact`, `fork`).

## 0.1.1 — 2026-06-21
- Secret scanner labels Anthropic keys (`sk-ant-…`) as `anthropic-key` instead of `openai-key`; openai pattern excludes the `ant-` prefix so a key yields one finding, not two.
- CI: GitHub Actions runs the test suite on Node 20 + 22 for pushes and PRs.
- Added `SECURITY.md` with a private vulnerability-reporting path.

## 0.1.0 — 2026-06-15
- Phase A: automatic startup + per-turn AutoMem recall (via mcp-automem sidecar).
- Fail-closed PreToolUse write gate: normalize → secret-scan → policy → dedupe.
- `/automem-status`, `/automem-recall` commands; usage skill; JSONL observability.

### Phase A review hardening (deep-recall `/code-review high`)
- **Gate no longer fails open on server rename:** `PreToolUse` matcher is now server-agnostic; the hook filters to the configured `mcpServerName`. `/automem-status` verifies the matcher fires for your server.
- `update_memory` now enforces the hard content-length cap (parity with `store`).
- Secret scanner adds JWT, Google API key, Slack, and Stripe live-key patterns; lower assignment-value threshold.
- Allow-paths emit an allowlisted `updatedInput` (store + update) instead of forwarding raw tool input — unknown fields never reach AutoMem unscanned.
- MCP client bounds a whole recall by `timeoutMs` (shared deadline across init + call) and initializes once under concurrent recalls.
- Startup recall queries run concurrently; dedupe degrade is now logged, not silently swallowed; `getClientFactory`/`readStdin` consolidated into `lib/runtime.mjs`; config no longer aliases shared defaults; over-length advisories separated from gating reasons.
