// Map cwd / prompt to a project tag using the configured projectDetection map.
export function detectProject(cwd, prompt, config) {
  const map = config?.projectDetection || {};
  const haystack = ((cwd || "") + " " + (prompt || "")).toLowerCase();
  for (const [needle, tag] of Object.entries(map)) {
    if (haystack.includes(String(needle).toLowerCase())) {
      return { projectTag: tag, projectLabel: tag };
    }
  }
  return { projectTag: "", projectLabel: "" };
}
