// The AutoMem tools this plugin treats as "a write", and the narrowing from a raw Claude
// Code tool name down to one of them.
//
// Shared by the PreToolUse gate, the PostToolUse/PostToolUseFailure outcome recorder and the
// PermissionDenied denial recorder ON PURPOSE. `/automem-status` joins gate decisions to write
// outcomes by `tool_use_id`; if these hooks ever narrowed to different tool sets, the join
// would not fail loudly — every write one hook saw and another did not would quietly surface
// as an unconfirmed write or an orphan outcome, which is exactly the class of silent wrongness
// this correlation exists to remove. One definition, one drift surface.
export const WRITE_SUFFIXES = ["store_memory", "update_memory", "delete_memory", "associate_memories"];

export function isWriteTool(name, serverName) {
  const prefix = `mcp__${serverName}__`;
  return typeof name === "string" && name.startsWith(prefix) && WRITE_SUFFIXES.includes(name.slice(prefix.length));
}
