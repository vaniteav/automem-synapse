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
  // Catch-all for credential formats the specific rules above don't know. It is the
  // only rule keyed on the *word* rather than the value's shape, so it is the only one
  // that can fire on ordinary prose — and this plugin stores memories ABOUT engineering,
  // where sentences like "never put password = anything in a tracked file" are exactly
  // the kind of thing worth remembering. Measured 2026-08-02 against 7 weeks of real
  // gate decisions: 129 of 184 denials were the scanner, and the old form of this rule
  // blocked 5 of 7 representative prose/placeholder samples.
  //
  // Narrowed on three axes, each of which a genuine credential satisfies and prose does not:
  //   not a placeholder   — <...>, your-*, example*, xxx, {{...}}, REDACTED
  //   credential charset  — no spaces, none of the punctuation prose uses
  //   entropy-ish value   — >=10 chars WITH a digit, or >=16 chars regardless
  //
  // The two-branch value test is deliberate. A flat >=16 floor was tried first and made
  // `password = "S3cr3tPass2024"` (14) a false NEGATIVE — the repo's own pre-existing test
  // caught it. Short-with-digits and long-without-digits are both real password shapes;
  // "anything" (8, all lowercase) is neither.
  //
  // Trade accepted: a short, all-lowercase, dictionary-word credential is no longer caught
  // HERE. The 11 shape-based rules above still catch every known token format regardless of
  // assignment syntax, and a test asserts that explicitly.
  { kind: "secret-assignment", regex: /\b(?:api[_-]?key|token|secret|password|passwd|credential)s?\b\s*[:=]\s*['"]?(?!<|your[-_]|example|placeholder|xxx|\.\.\.|\{\{|REDACTED)(?:(?=[A-Za-z0-9_\-\/+=.]*[0-9])[A-Za-z0-9_\-\/+=.]{10,}|[A-Za-z0-9_\-\/+=.]{16,})/i },
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
