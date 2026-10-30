import WebSocket from "ws";
import type { BoatClient } from "./boat-client.js";
import type { BoatProviderOptions } from "./boat-provider.js";
import { BOAT_READY_STATES, boatSleep } from "./boat-registration-state.js";

export async function waitBoatReady(
  client: () => BoatClient,
  options: BoatProviderOptions,
  token: string,
  sandboxId: string,
): Promise<string> {
  const deadline = Date.now() + (options.readyTimeoutMs ?? 180_000);
  const interval = options.pollIntervalMs ?? 2_000;
  for (;;) {
    const sandbox = await client().getSandbox(token, sandboxId);
    if (BOAT_READY_STATES.has(sandbox.state)) {
      if (!sandbox.url) throw new Error("boat: sandbox has no base URL");
      return sandbox.url;
    }
    if (sandbox.state === "error")
      throw new Error(`boat: sandbox ${sandboxId} entered error state`);
    if (Date.now() > deadline)
      throw new Error(`boat: sandbox ${sandboxId} did not become ready`);
    await boatSleep(interval);
  }
}

/** Wait until the in-sandbox relay accepts a WebSocket upgrade. */
export async function waitBoatRelay(
  options: BoatProviderOptions,
  webSocketUrl: string,
  cookie?: string,
): Promise<void> {
  const deadline = Date.now() + (options.agentReadyTimeoutMs ?? 60_000);
  const interval = options.pollIntervalMs ?? 1_000;
  for (;;) {
    const opened = await new Promise<boolean>((resolve) => {
      const probe = new WebSocket(webSocketUrl, {
        followRedirects: false,
        handshakeTimeout: 10_000,
        headers: cookie ? { cookie } : {},
      });
      probe.once("open", () => {
        probe.close();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });
    if (opened) return;
    if (Date.now() > deadline)
      throw new Error("boat: relay agent did not start in the sandbox");
    await boatSleep(interval);
  }
}
