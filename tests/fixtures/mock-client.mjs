export function createAutomemClient() {
  return {
    recall: async () => ({ text: "Found 1 memories:\n\n1. mock memory [t] score=0.9\n   ID: m1" }),
    health: async () => ({ ok: true, status: 200 }),
  };
}
