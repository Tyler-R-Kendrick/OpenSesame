/**
 * Executable entry for the in-sandbox Boat relay agent. The default
 * bootstrap command clones this repository into the sandbox and runs
 * this file with tsx; configuration comes only from the per-sandbox
 * environment the provider created with the sandbox (see
 * `BOAT_AGENT_ENV` in boat-agent.ts).
 */

import { createLogger } from "@opensesame/observability";
import { startBoatRelayAgent } from "./boat-agent.js";

const log = createLogger({ name: "boat-relay-agent" });
const agent = await startBoatRelayAgent(process.env);
log.info({ host: "127.0.0.1", port: agent.port }, "Boat relay agent listening");

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
