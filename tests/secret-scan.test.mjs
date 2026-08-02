import { test } from "node:test";
import assert from "node:assert/strict";
import { scanForSecrets } from "../scripts/lib/secret-scan.mjs";

const hasSecrets = (text) => scanForSecrets(text).length > 0;

test("detects a bearer token and redacts the match", () => {
  const f = scanForSecrets("Authorization: Bearer abcdef0123456789ABCDEF");
  assert.equal(f.length >= 1, true);
  assert.equal(f[0].kind, "bearer-token");
  assert.doesNotMatch(f[0].match, /abcdef0123456789ABCDEF/); // redacted
});

// Provider-shaped fixtures below are split with `+` so the literal token never
// appears contiguous in source — this keeps GitHub/gitleaks push-protection from
// flagging this test file. `scanForSecrets` still receives the full joined string,
// so detection is tested exactly as before.
test("detects openai key, aws key, private key header, connection string", () => {
  assert.equal(hasSecrets("sk-" + "abcdefghijklmnopqrstuvwx"), true);
  assert.equal(hasSecrets("AKIA" + "1234567890ABCD12"), true);
  assert.equal(hasSecrets("-----BEGIN RSA PRIVATE KEY-----"), true);
  assert.equal(hasSecrets("postgres://user:pw@host:5432/db"), true);
});

test("clean text has no findings", () => {
  assert.equal(hasSecrets("User prefers Vitest over Jest"), false);
});

test("anthropic key is labeled anthropic-key, not double-counted as openai", () => {
  const f = scanForSecrets("sk-ant-" + "api03abcdefghijklmnopqrstuvwx");
  const kinds = f.map((x) => x.kind);
  assert.deepEqual(kinds, ["anthropic-key"]);
});

test("detects JWT, Google API key, Slack token, Stripe live key", () => {
  assert.equal(hasSecrets("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." + "eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"), true, "JWT");
  assert.equal(hasSecrets("key AIza" + "SyA1234567890abcdefghijklmnopqrstuvw"), true, "Google API key");
  assert.equal(hasSecrets("xoxb" + "-1234567890-abcdefghijklmnop"), true, "Slack bot token");
  assert.equal(hasSecrets("sk_live" + "_abcdefghijklmnopqrstuvwx"), true, "Stripe live key");
});

test("detects a short secret assignment (under 20 chars)", () => {
  assert.equal(hasSecrets('password = "S3cr3tPass2024"'), true);
});

test("does not flag ordinary prose with the word password", () => {
  assert.equal(hasSecrets("Remember to rotate the password next quarter"), false);
});

// ── secret-assignment: catch credentials, not prose about them ────────────────
// This rule is the only one keyed on a WORD rather than the value's shape, so it is
// the only one that can fire on ordinary writing. That matters here more than in a
// scanner over source files: this plugin stores memories about engineering work, and
// "never put password = anything in a tracked file" is exactly the sort of thing worth
// remembering. Measured 2026-08-02 over 7 weeks of real gate decisions, 129 of 184
// denials were the scanner, and the pre-narrowing rule blocked 5 of 7 representative
// prose samples. Both directions are asserted so neither can regress silently.

test("secret-assignment blocks real credential assignments", () => {
  for (const s of [
    "api_key: 7f3a9c2e5b8d1f4a6c0e2b7d9",
    'password="hunter2correcthorsebattery"',
    "credential = aGVsbG93b3JsZGZvb2JhcjEyMzQ1Ng==",
    "token: ghs_AbCdEfGhIjKlMnOpQrStUvWxYz012345",
  ]) {
    const kinds = scanForSecrets(s).map((f) => f.kind);
    assert.ok(kinds.length > 0, `expected a finding for: ${s}`);
  }
});

test("secret-assignment does NOT fire on prose or placeholders", () => {
  for (const s of [
    "Never put password = anything into a tracked file; use the vault",
    "Set token: <your-token-here> in the config before first run",
    "api_key: your-key-here goes in keys.env",
    "secret: example-value-not-real",
    "password: abc123",                                     // too short to be a credential
    "The loader reads api_key: from keys.env at runtime",   // no value at all
    "token: {{TOKEN}}",                                     // template placeholder
  ]) {
    assert.deepEqual(
      scanForSecrets(s).filter((f) => f.kind === "secret-assignment"),
      [],
      `secret-assignment should not fire on: ${s}`,
    );
  }
});

test("narrowing secret-assignment did not weaken the shape-based rules", () => {
  // The trade for narrowing was accepting lower recall on unknown SHORT formats. Every
  // known token format must still be caught regardless of assignment syntax — otherwise
  // the narrowing bought a real hole rather than a false-positive fix.
  const mustStillCatch = {
    "anthropic-key": "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA",
    "github-token": "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345",
    "aws-access-key": "AKIAIOSFODNN7EXAMPLE",
    "private-key": "-----BEGIN RSA PRIVATE KEY-----",
    "connection-string": "postgres://user:pass@localhost/db",
    "jwt": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123",
  };
  for (const [kind, sample] of Object.entries(mustStillCatch)) {
    const kinds = scanForSecrets(`some prose ${sample} more prose`).map((f) => f.kind);
    assert.ok(kinds.includes(kind), `${kind} must still be detected in prose`);
  }
});

test("secret-assignment catches short-but-high-entropy values (regression)", () => {
  // A flat >=16 length floor was tried first and made this a false NEGATIVE. The repo's
  // own "detects a short secret assignment" test caught it. Short-with-digits and
  // long-without-digits are both real password shapes; keep both covered here so the
  // two-branch value test cannot be simplified back into a single length floor.
  assert.equal(hasSecrets('password = "S3cr3tPass2024"'), true, "14 chars, has digits");
  assert.equal(hasSecrets("password: correcthorsebattery"), true, "19 chars, no digits");
  assert.equal(hasSecrets("password = anything more prose"), false, "8 chars, all lowercase");
});
