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
