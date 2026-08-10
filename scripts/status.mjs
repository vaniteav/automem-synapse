import { loadConfig } from "./lib/config.mjs";
import { openSync, fstatSync, readSync, closeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { getClientFactory } from "./lib/runtime.mjs";

// This used to `readFileSync` the entire log. The log is append-only and nothing rotates it,
// so that read grew for the life of the install, and it was already reading far more than
// the question needed: "what happened lately". Both bounds below are explicit on purpose —
// bytes off disk, and records fed to the correlator.
const TAIL_BYTES = 256 * 1024;        // how much of the file's tail is read at all
const CORRELATION_WINDOW = 200;       // how many of the parsed records the summary spans

function readTail(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    // readSync is not obliged to fill the buffer in one call; loop until it does or stops.
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const text = buf.subarray(0, read).toString("utf8");
    // Seeking to a byte offset can land mid-line; drop that first partial record. (When the
    // whole file fit in the window, start === 0 and there is nothing partial to drop.)
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

// Correlate gate decisions against downstream write outcomes.
//
// The gate logs `decision:"allow"` BEFORE the AutoMem write runs; `post-tool-use.mjs` logs
// what the write actually did. Neither line is the whole story on its own, and reading the
// gate's line as if it were is what let "my memories aren't saving" show up here as a clean
// log and `healthy: true`. Joining them is done here, in a reporter a human explicitly ran,
// rather than in a hook — hooks log facts, status does the analysis.
//
// Join key is `toolUseId` (`tool_use_id`, documented on PreToolUse, PostToolUse and
// PostToolUseFailure alike), so this is an exact id match, not timestamp proximity.
//
// Two honest caveats, both consequences of a bounded window rather than bugs:
//   * `unconfirmed` counts a write whose outcome record has not been written yet — the
//     in-flight write at the moment `/automem-status` runs will normally sit here.
//   * `orphanOutcomes` is inflated at the head of the window: outcomes arrive after their
//     gate line, so a window that cut the head off separates them. That category is real and
//     wanted (a write the gate never saw — rotated logs, or the gate wired later), and the
//     `window` figure is reported alongside so the boundary is visible rather than implied.
function correlate(lines) {
  const gate = new Map();      // toolUseId -> PreToolUse decision line
  const outcome = new Map();   // toolUseId -> PostToolUse/PostToolUseFailure outcome line
  let uncorrelatable = 0;
  for (const l of lines) {
    const isOutcome = typeof l.outcome === "string";
    const isGate = l.hook === "PreToolUse" && typeof l.decision === "string";
    if (!isOutcome && !isGate) continue;
    // Lines written before the correlation key existed carry no `toolUseId` at all. They are
    // genuine decisions, so they are counted and surfaced — but they can never be joined to
    // anything, and folding them into `unconfirmed` would report every historical write as a
    // silent failure. Degrading a legacy log to "unknown" is honest; degrading it to "broken"
    // is not.
    if (!l.toolUseId) { uncorrelatable++; continue; }
    (isOutcome ? outcome : gate).set(l.toolUseId, l);
  }
  let allowed = 0, confirmed = 0, failedDownstream = 0, unconfirmed = 0;
  for (const [id, g] of gate) {
    if (g.decision === "deny") continue; // the one decision that truly never reaches AutoMem
    const o = outcome.get(id);
    // ask / no-opinion are permission-dependent: the user (or the normal permission flow) may
    // still approve execution downstream of the gate. Without a matching outcome we cannot tell
    // "denied at the prompt" from "still pending", so only count them once an outcome proves the
    // write actually ran. `allow` always runs, so silence there really does mean in-flight.
    if (g.decision !== "allow" && !o) continue;
    allowed++;
    if (!o) unconfirmed++;
    else if (o.outcome === "failure") failedDownstream++;
    else confirmed++;
  }
  let orphanOutcomes = 0;
  for (const id of outcome.keys()) if (!gate.has(id)) orphanOutcomes++;
  return { window: lines.length, allowed, confirmed, failedDownstream, unconfirmed, orphanOutcomes, uncorrelatable };
}

function tailLog(file) {
  try {
    const lines = readTail(file).trim().split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const last = lines[lines.length - 1] || null;
    // Broadened: a write that cleared the gate and then failed downstream is a failure too,
    // and the old predicate could not see one. `l.error` catches most outcome failures (the
    // recorder copies the tool's error string), but not all — a failure can arrive with no
    // error text, e.g. an abort — so the explicit outcome field is matched as well.
    //
    // `lastFailure` keeps its meaning but not its old unlimited reach: it now searches the
    // tail read above rather than the whole file, so a failure older than TAIL_BYTES no
    // longer surfaces. That is the intended trade — the field answers "did something break
    // lately", and a months-old deny resurfacing forever was noise, not signal.
    const lastFailure = [...lines].reverse().find((l) => l.error || l.decision === "deny" || l.outcome === "failure") || null;
    return { last, lastFailure, writeOutcomes: correlate(lines.slice(-CORRELATION_WINDOW)) };
  } catch { return { last: null, lastFailure: null, writeOutcomes: null }; }
}
async function preToolUseMatcher() {
  try {
    const h = JSON.parse(await readFile(new URL("../hooks/hooks.json", import.meta.url), "utf8"));
    return h.hooks?.PreToolUse?.[0]?.matcher || "";
  } catch { return ""; }
}
// Drift check: does the configured server's write tool actually trigger the matcher?
// Tests the matcher directly rather than parsing a server name out of it, so it stays
// correct for a server-agnostic (mcp__.*__) matcher and for any rename.
function matcherFires(matcher, serverName) {
  if (!matcher) return false;
  try { return new RegExp(matcher).test(`mcp__${serverName}__store_memory`); } catch { return false; }
}

(async () => {
  const config = loadConfig();
  let healthy = false, status = 0, memoryCount = null;
  try {
    const createClient = await getClientFactory();
    const client = createClient({ url: config.server.url, token: config.server.token, timeoutMs: 8000 });
    const h = await client.health();
    healthy = h.ok; status = h.status;
    memoryCount = h.body?.memory_count ?? h.body?.count ?? h.body?.memories ?? null;
  } catch { /* report unhealthy */ }
  const { last, lastFailure, writeOutcomes } = tailLog(config.observability.logFile);
  const matcher = await preToolUseMatcher();
  const matcherMismatch = matcherFires(matcher, config.mcpServerName)
    ? null
    : `WARNING: hooks.json PreToolUse matcher does not fire for "mcp__${config.mcpServerName}__store_memory" — the write gate will NOT run for server "${config.mcpServerName}". Edit hooks/hooks.json.`;
  process.stdout.write(JSON.stringify({
    healthy, status, memoryCount,
    serverUrl: config.server.url,
    tokenPresent: !!config.server.token,
    mcpServerName: config.mcpServerName,
    matcherMismatch,
    writePolicyMode: config.writePolicy.mode,
    startupRecall: config.startupRecall.enabled,
    turnRecall: config.turnRecall.enabled,
    lastHookResult: last,
    lastFailure,
    writeOutcomes,
    logFile: config.observability.logFile,
  }, null, 2));
})();
