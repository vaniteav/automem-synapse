<div align="center">

![automem-synapse](assets/banner.png)

</div>

# automem-synapse

> **AutoMem is the memory. This plugin makes Claude Code actually use it.**

[![GitHub release](https://img.shields.io/github/v/release/vaniteav/automem-synapse)](https://github.com/vaniteav/automem-synapse/releases)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A Claude Code plugin that fires AutoMem recall automatically — at session start and before every turn — and guards every memory write behind a fail-closed secret-scanning, policy-gated pipeline.

---

## Why

Claude Code can call AutoMem tools, but it won't reach for them unprompted. Without automation, recall is a manual chore and writes go unchecked. automem-synapse closes that gap:

- **Startup recall** — your working style, environment, and active projects are injected into the system prompt before the first message.
- **Per-turn recall** — relevant memories are silently surfaced before each prompt, so the model stays oriented without being told to look.
- **Fail-closed write gate** — every `store_memory`, `update_memory`, and `associate_memories` call passes through normalize → secret-scan → policy → dedupe before it reaches AutoMem. Secrets are blocked; duplicates are flagged; sensitive categories require confirmation.
- **Correction provenance** — the usage skill guides Claude to link superseded memories with `associate_memories(EVOLVED_INTO)` rather than silently overwriting.

---

## How it works

The plugin wires three Claude Code hooks:

| Hook | What it does |
|---|---|
| `SessionStart` | Runs startup recall queries; injects results into the system prompt. |
| `UserPromptSubmit` | Runs per-turn recall before each prompt; injects relevant memories as additional context. |
| `PreToolUse` | Intercepts `mcp__automem__store_memory`, `update_memory`, `delete_memory`, and `associate_memories`; runs the write gate; returns `allow`, `ask` (with reason), or `deny`. |

All three run as local `node` commands — no separate process to keep alive, no network calls except to your AutoMem instance.

---

## Before you begin

This plugin connects Claude Code to your existing AutoMem stack. You need both running first:

1. **[AutoMem](https://github.com/verygoodplugins/automem)** — the graph-vector memory service (self-hosted or Railway).
2. **[mcp-automem](https://github.com/verygoodplugins/mcp-automem)** — the MCP sidecar that exposes AutoMem's tools to Claude Code.

Confirm your mcp-automem sidecar is registered in Claude Code under a server named `automem` (or see the warning in [Configure](#configure) if you use a different name).

---

## Install

```bash
claude plugin marketplace add vaniteav/automem-synapse
claude plugin install automem-synapse@vaniteav-marketplace
```

Or point `claude plugin` at a local path during development:

```bash
claude plugin marketplace add ./
claude plugin install automem-synapse@vaniteav-marketplace
```

The plugin registers the three hooks and two commands automatically. Nothing recalls yet — it has no token to talk to your server.

---

## Configure

Create `~/.claude/automem-synapse.json`. At minimum:

```json
{
  "server": {
    "url": "https://your-mcp-automem-host/mcp",
    "tokenEnv": "AUTOMEM_API_KEY"
  }
}
```

Then export your token in your shell profile:

```sh
export AUTOMEM_API_KEY="your-token-here"
```

**Never inline the token value in the JSON file** — `tokenEnv` is the key name of an environment variable; the plugin reads the token from the environment at runtime. This keeps credentials out of config files that might end up in version control.

> **Renaming the MCP server?** The `PreToolUse` matcher in `hooks/hooks.json` is server-agnostic (`mcp__.*__store_memory|…`), so the write gate fires for any `mcpServerName` — the hook itself filters to your configured server. `/automem-status` independently verifies the matcher would fire for your server and warns if a custom edit ever breaks that.

Any key you omit falls back to its default. Two ready-to-edit starting points are in `examples/`:

- **`config.minimal.json`** — the smallest useful config.
- **`config.advanced.json`** — every option, filled in with sensible defaults. Copy it, trim what you don't need.

### Config reference

| Section | Purpose |
|---|---|
| `mcpServerName` | Which MCP server name to use (default: `"automem"`) |
| `server.url` | URL of your mcp-automem sidecar |
| `server.tokenEnv` | Name of the env var holding the bearer token |
| `startupRecall` | Queries, tags, byte budget, and timeout for session-start recall |
| `turnRecall` | Per-prompt recall: limits, memory types, relation/entity expansion, timeout |
| `projectDetection` | Map folder names to project tags for scoped recall |
| `projectOverrides` | Per-project overrides for recall limits and filters |
| `writePolicy` | Write mode, auto/confirm/blocked categories, importance threshold, dedupe |
| `behavior` | Display mode (`hidden`/`summary`/`full`) and content-length limits |
| `observability.logFile` | Path to the JSONL decision log (default: `~/.claude/automem-synapse.log`) |

---

## Commands

| Command | What it does |
|---|---|
| `/automem-status` | Health check — shows connectivity, active config summary, and log file path |
| `/automem-recall <query>` | Run a manual recall query — useful for debugging what the hook would inject |

---

## Write policy

Every write is routed through: **normalize → secret-scan → policy check → dedupe → confirm or auto-store**. The gate is fail-closed: any pipeline error results in a deny, not a pass.

```json
{
  "writePolicy": {
    "mode": "safe-auto",
    "autoWriteCategories": ["technical-decision", "agent-pattern", "bug-fix", "tooling-lesson"],
    "confirmCategories": ["personal", "financial", "private", "identity"],
    "blockedCategories": ["secret", "credential", "api-key", "raw-transcript"],
    "minImportanceToWrite": 0.7,
    "dedupeBeforeWrite": true,
    "dedupeMinScore": 0.85,
    "alwaysTag": ["agent:claude-code"]
  }
}
```

| Mode | Behavior |
|---|---|
| `safe-auto` | Auto-write configured low-risk categories; confirm everything else. **Default.** |
| `confirm-all` | Confirm every write individually. |
| `off` | Block all writes. |

When the gate returns `ask` with "possible duplicate of `<id>`", prefer `mcp__automem__update_memory` on that ID over creating a near-identical memory. See the usage skill for full correction guidance.

---

## Development

```bash
git clone https://github.com/vaniteav/automem-synapse.git
cd automem-synapse
npm test            # offline unit + hook tests, no server needed
npm run test:smoke  # live round-trip (needs AUTOMEM_API_KEY + a running AutoMem)
```

Node >= 20 required. Zero runtime dependencies.

---

## Credits

- **[AutoMem](https://github.com/verygoodplugins/automem)** by [Very Good Plugins](https://github.com/verygoodplugins) — the graph-vector memory service powering recall and storage.
- **[mcp-automem](https://github.com/verygoodplugins/mcp-automem)** by [Very Good Plugins](https://github.com/verygoodplugins) — the MCP sidecar this plugin communicates through.
- **[pi-automem-bridge](https://github.com/vaniteav/pi-automem-bridge)** — sibling package; same recall-and-gate pattern for the pi agent.

---

## License

MIT — [vaniteav](https://github.com/vaniteav)
