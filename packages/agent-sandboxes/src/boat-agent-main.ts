/**
 * Executable entry for the in-sandbox Boat relay agent. The default
 * bootstrap command clones this repository into the sandbox and runs
 * this file with tsx; configuration comes only from the per-sandbox
 * environment the provider created with the sandbox (see
 * `BOAT_AGENT_ENV` in boat-agent.ts).
 */

import { startBoatRelayAgent } from "./boat-agent.js";

const agent = await startBoatRelayAgent(process.env);
console.log(`boat relay agent listening on 127.0.0.1:${agent.port}`);

let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    agent
      .close()
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}
