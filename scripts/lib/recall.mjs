// parseSearchResults ported from pi-automem-bridge/src/recall.ts
const KNOWN_TYPES = new Set(["Decision", "Pattern", "Preference", "Style", "Habit", "Insight", "Context"]);

export function parseSearchResults(text) {
  if (!text || !text.trim()) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((it) => ({
        id: it.id || it.memory_id || "",
        type: it.type || it.memory_type || "Context",
        content: it.content || it.text || "",
        tags: Array.isArray(it.tags) ? it.tags : [],
        score: it.score ?? it.similarity ?? undefined,
      }));
    }
  } catch { /* not JSON */ }

  if (/^Found\s+\d+\s+memories:/i.test(text.trim())) {
    const memories = [];
    const lines = text.split("\n");
    let current = [];
    const flush = () => {
      if (current.length === 0) return;
      const raw = current.join("\n").trim();
      if (!raw) return;
      const idMatch = raw.match(/(?:^|\n)ID:\s*([^\s]+)/i);
      const scoreMatch = raw.match(/\bscore=([0-9.]+)/i);
      const firstLine = raw.split("\n")[0] || raw;
      const content = firstLine.replace(/^\d+\.\s*/, "").replace(/\s+score=[0-9.]+\s*$/i, "").trim();
      const tagMatch = content.match(/\[([^\]]+)\]\s*$/);
      const tags = tagMatch ? tagMatch[1].split(",").map((t) => t.trim()).filter(Boolean) : [];
      let clean = tagMatch ? content.slice(0, tagMatch.index).trim() : content;
      const typePrefix = clean.match(/^\[([A-Za-z]+)\]\s*/);
      const detectedType = typePrefix && KNOWN_TYPES.has(typePrefix[1]) ? typePrefix[1] : "Context";
      if (typePrefix && KNOWN_TYPES.has(typePrefix[1])) clean = clean.slice(typePrefix[0].length);
      memories.push({ id: idMatch ? idMatch[1] : "", type: detectedType, content: clean, tags, score: scoreMatch ? Number(scoreMatch[1]) : undefined });
    };
    for (const line of lines) {
      if (/^\d+\.\s+/.test(line.trim())) { flush(); current = [line.trim()]; }
      else if (current.length > 0) current.push(line.trim());
    }
    flush();
    return memories;
  }
  return text.split("\n").filter((l) => l.trim()).map((l) => ({ id: "", type: "Context", content: l.trim(), tags: [] }));
}

function truncateToBytes(value, maxBytes) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let lo = 0, hi = value.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(value.slice(0, mid), "utf8") <= maxBytes) lo = mid; else hi = mid - 1;
  }
  return value.slice(0, lo);
}

export function formatMemoriesForContext(memories, maxBytes) {
  const lines = [];
  let bytes = 0, overflowed = false;
  for (const mem of memories) {
    const tagStr = mem.tags.length ? " (" + mem.tags.join(", ") + ")" : "";
    const entry = "[" + mem.type + "] " + mem.content + tagStr;
    const entryBytes = Buffer.byteLength(entry, "utf8") + 1;
    if (bytes + entryBytes > maxBytes && lines.length > 0) break;
    if (lines.length === 0 && entryBytes > maxBytes) { lines.push(truncateToBytes(entry, maxBytes)); overflowed = true; break; }
    lines.push(entry); bytes += entryBytes;
  }
  return { text: lines.join("\n"), included: lines.length, overflowed };
}

function dedupe(memories, all, seen) {
  for (const mem of memories) {
    if (mem.id && !seen.has(mem.id)) { seen.add(mem.id); all.push(mem); }
    else if (!mem.id) {
      const key = "content:" + mem.content.slice(0, 80);
      if (!seen.has(key)) { seen.add(key); all.push(mem); }
    }
  }
}

// client: { recall(query, opts) => Promise<{ text }> }
export async function startupRecall(client, config) {
  const sc = config.startupRecall;
  if (!sc?.enabled) return { text: "", count: 0, truncated: false, ids: [] };
  const all = [], seen = new Set();
  // Independent queries run concurrently; results are deduped in original query order
  // so the highest-priority query still wins on collisions.
  const settled = await Promise.allSettled(
    sc.queries.map((query) => client.recall(query, { limit: sc.limit, tags: sc.tags, tagMode: sc.tagMode })),
  );
  for (const r of settled) {
    if (r.status === "fulfilled") dedupe(parseSearchResults(r.value.text), all, seen);
  }
  const { text, included, overflowed } = formatMemoriesForContext(all, sc.maxBytes);
  return { text, count: all.length, truncated: included < all.length || overflowed, ids: all.map((m) => m.id).filter(Boolean) };
}

export async function turnRecall(client, prompt, project, config, excludeIds = new Set()) {
  const tc = config.turnRecall;
  if (!tc?.enabled) return { text: "", count: 0, truncated: false, ids: [] };
  const query = project?.projectLabel ? prompt + " " + project.projectLabel : prompt;
  const tags = project?.projectTag ? [project.projectTag.trim().toLowerCase()] : undefined;
  const rc = (project?.projectTag && config.projectOverrides?.[project.projectTag])
    ? { ...tc, ...config.projectOverrides[project.projectTag] } : tc;
  let memories = [];
  try {
    const { text } = await client.recall(query, {
      limit: rc.limit, tags, tagMode: "any", contextTypes: rc.contextTypes,
      expandRelations: rc.expandRelations, expandEntities: rc.expandEntities,
    });
    memories = parseSearchResults(text).filter((m) => !m.id || !excludeIds.has(m.id));
  } catch { return { text: "", count: 0, truncated: false, ids: [] }; }
  const { text, included, overflowed } = formatMemoriesForContext(memories, rc.maxBytes);
  return { text, count: memories.length, truncated: included < memories.length || overflowed, ids: memories.map((m) => m.id).filter(Boolean) };
}
