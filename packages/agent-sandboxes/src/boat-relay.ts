import WebSocket from "ws";
import { RelayBrowserDriver, webSocketRelayTransport } from "./relay-driver.js";
import { parseRelayResponse } from "./relay-protocol.js";

export interface BoatRelayConnection {
  browser: RelayBrowserDriver;
  terminate(): void;
}

export async function connectBoatRelay(
  url: string,
  token: string,
  cookie?: string,
): Promise<BoatRelayConnection> {
  const socket = new WebSocket(url, {
    followRedirects: false,
    handshakeTimeout: 10_000,
    headers: cookie ? { cookie } : {},
  });
  const ready = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ type: "auth", token })),
    );
    socket.addEventListener("message", (event) => {
      const response = parseRelayResponse(String(event.data));
      if (!response)
        return reject(new Error("boat: relay authentication failed"));
      if (response.id !== 0) return;
      if (response.ok) resolve();
      else reject(new Error("boat: relay authentication failed"));
    });
    socket.addEventListener("error", () =>
      reject(new Error("boat: relay connection failed")),
    );
    socket.addEventListener("close", () =>
      reject(new Error("boat: relay connection closed")),
    );
  });
  const timeout = setTimeout(() => socket.terminate(), 10_000);
  try {
    await ready;
  } catch (error) {
    socket.terminate();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  // SAFETY: ws implements the send, close, and addEventListener methods consumed by this transport.
  const browser = new RelayBrowserDriver(
    webSocketRelayTransport(
      socket as Parameters<typeof webSocketRelayTransport>[0],
      ready,
    ),
  );
  return { browser, terminate: () => socket.terminate() };
}

/** Always terminate the socket and continue sandbox cleanup after a bounded wait. */
export async function closeBoatRelay(
  relay: BoatRelayConnection,
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      relay.browser.close().catch(() => {}),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    relay.terminate();
  }
}
