---
description: Show automem-synapse health, AutoMem connectivity, active config, and whether recent memory writes actually landed.
---
Run the status reporter and summarize the result for the user (health, server URL, token presence, write-policy mode, recall toggles, last hook result/failure, and any matcher mismatch warning):

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs"`

Then report the `writeOutcomes` block in plain language. It correlates gate decisions against what each write actually did, over the last `window` log lines. The gate's `allow` is logged before the write runs, so `allowed` alone never means a memory was saved — say what happened to those writes:

- `confirmed` — allowed and confirmed saved. This is the healthy case.
- `failedDownstream` — cleared the gate, then did not land (timeout, 5xx, expired token, or an aborted call, which the record marks `interrupted: true`). **Call this out even when `healthy` is true**: the server can be reachable now and still have dropped writes. Quote `lastFailure` for the error, and if it was an interrupt say so — that is a cancelled call, not a broken server.
- `unconfirmed` — allowed, but nothing ever recorded an outcome. Expect a small number (a write in flight when the command ran); a persistent or growing count is the silent-failure case worth investigating.
- `orphanOutcomes` — a write outcome with no matching gate decision, i.e. a write the gate never saw. Usually harmless (the log window cut the pair apart, or the log was rotated), but if it is large relative to `window`, say the gate may not be firing for this server and point at the `matcherMismatch` warning.
- `uncorrelatable` — log lines predating write-outcome recording. These carry no correlation key, so nothing can be concluded about them. Say so; do not present them as failures.

If `writeOutcomes` is null the log file is missing or unreadable — mention it rather than reporting zero writes.
