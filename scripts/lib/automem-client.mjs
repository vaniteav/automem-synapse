// Minimal MCP streamable-HTTP client. Single surface: recall_memory.
const PROTOCOL_VERSION = "2024-11-05";

function extractResult(contentType, raw) {
  // application/json: a single JSON-RPC object. text/event-stream: SSE "data:" lines.
  if (contentType.includes("text/event-stream")) {
    // SSE: events are separated by a blank line; a payload is the concatenation of
    // its (possibly multiple) `data:` lines.
    for (const ev of raw.split(/\r?\n\r?\n/)) {
      const data = ev.split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data.trim()) continue;
      try { const obj = JSON.parse(data); if (obj.result || obj.error) return obj; } catch { /* keep scanning */ }
    }
    return {};
  }
  try { return JSON.parse(raw); } catch { return {}; }
}

export function createAutomemClient({ url, token, timeoutMs = 7000 }) {
  let sessionId = null;
  let initialized = false;
  let initPromise = null;

  async function rpc(message, { notify = false, deadline } = {}) {
    const ctrl = new AbortController();
    // When a deadline is supplied, every RPC in the same call shares it, so a whole
    // recall is bounded by timeoutMs total rather than timeoutMs per round trip.
    const ms = deadline ? Math.max(1, deadline - Date.now()) : timeoutMs;
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      };
      if (token) headers["Authorization"] = "Bearer " + token;
      if (sessionId) headers["Mcp-Session-Id"] = sessionId;
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(message), signal: ctrl.signal });
      const sid = res.headers.get("mcp-session-id");
      if (sid) sessionId = sid;
      if (notify) return {};
      const raw = await res.text();
      return extractResult(res.headers.get("content-type") || "", raw);
    } finally { clearTimeout(t); }
  }

  async function ensureInit(deadline) {
    if (initialized) return;
    // Memoize so concurrent recalls share one handshake; reset on failure so a later call retries.
    // The shared init gets its OWN full budget rather than a joining caller's remainder, so a
    // late joiner is never bounded by an earlier caller's (shorter) deadline.
    if (!initPromise) {
      const initDeadline = Date.now() + timeoutMs;
      initPromise = (async () => {
        const initRes = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "automem-synapse", version: "0.1.0" } } }, { deadline: initDeadline });
        if (initRes && initRes.error) throw new Error("MCP initialize failed: " + JSON.stringify(initRes.error));
        await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { notify: true, deadline: initDeadline });
        initialized = true;
      })().catch((e) => { initPromise = null; throw e; });
    }
    // Bound THIS caller's wait by its own deadline; the whole recall still stays within timeoutMs.
    let timer;
    const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("MCP init timed out")), Math.max(1, deadline - Date.now())); });
    try { await Promise.race([initPromise, guard]); }
    finally { clearTimeout(timer); }
  }

  async function recall(query, opts = {}) {
    const deadline = Date.now() + timeoutMs;
    await ensureInit(deadline);
    const args = { query, limit: opts.limit };
    if (opts.tags?.length) args.tags = opts.tags;
    if (opts.tagMode) args.tag_mode = opts.tagMode;
    if (opts.contextTypes?.length) args.context_types = opts.contextTypes;
    if (opts.expandRelations) args.expand_relations = true;
    if (opts.expandEntities) args.expand_entities = true;
    const resp = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recall_memory", arguments: args } }, { deadline });
    const text = resp?.result?.content?.[0]?.text || "";
    return { text };
  }

  async function health() {
    // sidecar exposes GET /health at the origin (strip the /mcp path)
    const base = url.replace(/\/mcp\/?$/, "");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(base + "/health", { signal: ctrl.signal, headers: token ? { Authorization: "Bearer " + token } : {} });
      let body = null; try { body = await res.json(); } catch { /* non-json health body */ }
      return { ok: res.ok, status: res.status, body };
    } catch { return { ok: false, status: 0, body: null }; } finally { clearTimeout(t); }
  }

  return { recall, health };
}
