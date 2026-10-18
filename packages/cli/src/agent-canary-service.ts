import { listenCanaryReceiver } from "@opensesame/app-core/node/agent-canary-http.js";
/** Explicit local receiver command. Pairing contains only the owner's public key. */
import {
  CanaryPairingSchema,
  createControlledCanaryReceiver,
} from "@opensesame/app-core/node/agent-canary-receiver.js";
import {
  openCanaryState,
  readPrivateCanaryPairing,
} from "@opensesame/app-core/node/agent-canary-state.js";
export async function runAgentCanaryService(
  pairingFile: string,
  stateDirectory: string,
) {
  const pairing = CanaryPairingSchema.parse(
    await readPrivateCanaryPairing(pairingFile),
  );
  const storage = await openCanaryState(stateDirectory, pairing.serviceId);
  try {
    const receiver = await createControlledCanaryReceiver(pairing, storage);
    const server = await listenCanaryReceiver(receiver);
    return {
      port: server.port,
      async close() {
        await server.close();
        await storage.close();
      },
    };
  } catch (error) {
    await storage.close();
    throw error;
  }
}
