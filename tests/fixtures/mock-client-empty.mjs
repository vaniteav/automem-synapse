export function createAutomemClient() {
  return { recall: async () => ({ text: "Found 0 memories:" }), health: async () => ({ ok: true, status: 200 }) };
}
