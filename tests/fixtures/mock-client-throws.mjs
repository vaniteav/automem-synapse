export function createAutomemClient() {
  return {
    recall: async () => { throw new Error("network down"); },
    health: async () => ({ ok: false, status: 0 }),
  };
}
