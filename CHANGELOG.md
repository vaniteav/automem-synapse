# Changelog

## Unreleased
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
