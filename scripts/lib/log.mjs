import { appendFileSync } from "node:fs";

export function appendLog(file, obj) {
  if (!file) return;
  try { appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n"); }
  catch { /* observability is best-effort; never break a hook */ }
}
