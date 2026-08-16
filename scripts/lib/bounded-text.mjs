// Bounding for the one class of log field this plugin copies from somebody else's text:
// a server-authored or host-authored string attached to a write that did not land — the
// `error` on `PostToolUseFailure`, the `reason` on `PermissionDenied`.
//
// This plugin's logging stance (see `pre-tool-use.mjs`) is kinds and outcomes, never content
// and never a matched secret value. Neither of those strings is under our control, and both
// can quote the request back — for a `store_memory` call the request IS the memory content —
// so every such string is bounded on two axes before it reaches the log:
//   1. if the repo's own secret scanner fires on it, the text is dropped entirely and only
//      the finding KINDS are kept — identical treatment to a matched secret in the gate;
//   2. otherwise it is hard-capped at MAX_LOGGED_CHARS.
//
// The cap bounds leakage, it does not eliminate it: the first 200 characters of an echoing
// string could still contain content. That is the accepted trade — the head is where the
// status code, the error class, or the denial reason lives, and a field with nothing
// diagnostic left in it would not have caught the failures this logging exists to catch.
//
// Shared by `post-tool-use.mjs` and `permission-denied.mjs` deliberately, for the same reason
// `write-tools.mjs` is shared: if one handler redacted and the other did not, or if one cap
// drifted from the other, nothing would fail loudly — the log would just quietly become less
// safe on one path than the other. One definition, one drift surface.
import { scanForSecrets } from "./secret-scan.mjs";

export const MAX_LOGGED_CHARS = 200;

export function boundForLog(raw) {
  if (raw === undefined || raw === null) return undefined; // the field can legitimately be absent (e.g. an abort)
  const text = String(raw);
  const kinds = scanForSecrets(text).map((f) => f.kind);
  if (kinds.length) return `[redacted: ${kinds.join(",")}]`;
  return text.length > MAX_LOGGED_CHARS ? text.slice(0, MAX_LOGGED_CHARS) + "…[truncated]" : text;
}
