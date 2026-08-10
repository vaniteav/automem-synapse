---
name: automem-synapse
description: How to use automem-synapse — automatic AutoMem recall and the fail-closed write gate. Use when storing memories, recording corrections, or debugging recall/gate behavior in Claude Code.
---

# automem-synapse

This plugin recalls AutoMem memories automatically (session start + per turn) and gates every memory write.

## Storing a memory
Just call `mcp__automem__store_memory` as normal. The PreToolUse gate will:
- **deny** writes containing secrets or blocked categories,
- **ask** you to confirm sensitive categories or likely duplicates (it returns the existing memory's ID),
- **allow** routine writes, transparently normalizing tags/importance/type first.

## Recording a correction (provenance)
When a memory is wrong or outdated, do NOT just overwrite silently:
1. Store (or update) the corrected memory.
2. Link old → new with `mcp__automem__associate_memories` using a relationship type of `EVOLVED_INTO` (superseded) or `CONTRADICTS` (conflicting). This preserves history (archive-never-delete).

## Duplicates
If the gate says `ask` with "possible duplicate of <id>", prefer `mcp__automem__update_memory` on that ID over creating a near-identical memory.

## Debugging
- `/automem-status` — health, connectivity, active config, log file.
- `/automem-recall <query>` — see what recall returns for a query.
- Logs: the JSONL file in `observability.logFile` records each hook's decision, latency, and byte count — **and, for every gated write, what the write actually did afterwards** (`outcome: "success"` or `"failure"`, with the error and duration on a failure). The gate's `allow` line is written before the write executes, so it alone never proves a memory was saved; `/automem-status` joins the two by `toolUseId` and reports writes that failed downstream or were allowed but never confirmed. Outcomes and error kinds are logged; memory content never is.
