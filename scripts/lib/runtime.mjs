// Shared hook/CLI runtime helpers. Single home for the test-injection contract
// (AUTOMEM_SYNAPSE_TEST_CLIENT) and stdin reading, so they aren't copy-pasted per script.

export async function getClientFactory() {
  if (process.env.AUTOMEM_SYNAPSE_TEST_CLIENT) {
    return (await import(process.env.AUTOMEM_SYNAPSE_TEST_CLIENT)).createAutomemClient;
  }
  return (await import("./automem-client.mjs")).createAutomemClient;
}

export async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
