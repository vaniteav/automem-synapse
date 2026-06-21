# Security Policy

## Reporting a vulnerability

automem-synapse guards every memory write behind a fail-closed secret-scanning,
policy-gated pipeline. If you find a way to bypass that gate, leak secrets, or
otherwise compromise the plugin, please report it privately.

- Use [GitHub private vulnerability reporting](https://github.com/vaniteav/automem-synapse/security/advisories/new), or
- Open an issue marked **SECURITY** with no sensitive details and ask for a private channel.

Please do not include real secrets in reports — a redacted sample or pattern is enough.

## Scope

In scope: the hook scripts (`scripts/`), the write gate, and the secret scanner.
Out of scope: your AutoMem instance and the `mcp-automem` sidecar — report those to
their respective projects.
