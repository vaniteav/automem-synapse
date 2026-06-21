// Ported from pi-automem-bridge/src/secret-scan.ts
const SECRET_PATTERNS = [
  { kind: "private-key", regex: /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/i },
  { kind: "bearer-token", regex: /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i },
  { kind: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { kind: "anthropic-key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "openai-key", regex: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/ },
  { kind: "stripe-key", regex: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/ },
  { kind: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}/ },
  { kind: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "jwt", regex: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
  { kind: "secret-assignment", regex: /\b(?:api[_-]?key|token|secret|password|passwd|credential)\b\s*[:=]\s*['"]?[^\s'"]{8,}/i },
  { kind: "connection-string", regex: /\b(?:postgres|mysql|mongodb|redis):\/\/[^\s]+/i },
];

export function scanForSecrets(text) {
  const findings = [];
  for (const p of SECRET_PATTERNS) {
    const m = String(text).match(p.regex);
    if (m && m[0]) findings.push({ kind: p.kind, match: redact(m[0]) });
  }
  return findings;
}

function redact(value) {
  if (value.length <= 12) return "[redacted]";
  return value.slice(0, 6) + "…" + value.slice(-4);
}
