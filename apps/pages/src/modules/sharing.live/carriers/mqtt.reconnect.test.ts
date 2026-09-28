/** @vitest-environment node */
/**
 * An MQTT broker that cannot be used is knocked on once, not for as long as
 * the tab lives. The real client (mqtt.js) against a server that completes
 * the WebSocket handshake and then drops the connection with no CONNACK — the
 * shape of a browser's failed socket, which reports a close and no error:
 * the promise rejects, and the connection count stops. `connectAsync`'s
 * default retries every few seconds, forever, with nothing that leaving,
 * ending or locking could reach.
 */

import { createHash } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { mqttCarrier } from "./mqtt.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
  server = null;
});

/** Upgrades, then hangs up: opens, never answers CONNECT. */
async function unwelcoming() {
  let upgrades = 0;
  const listening = createServer();
  listening.on("upgrade", (request, socket) => {
    upgrades += 1;
    const key = String(request.headers["sec-websocket-key"]);
    const accept = createHash("sha1")
      .update(key + GUID)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "Sec-WebSocket-Protocol: mqtt",
        "",
        "",
      ].join("\r\n"),
    );
    setTimeout(() => socket.destroy(), 20);
  });
  server = listening;
  await new Promise<void>((resolve) =>
    listening.listen(0, "127.0.0.1", () => resolve()),
  );
  // SAFETY: listening on a TCP port, not a pipe, so `address()` is an AddressInfo.
  const { port } = listening.address() as AddressInfo;
  return { port, count: () => upgrades };
}

describe("an MQTT broker that cannot be used", () => {
  it("rejects, and stops knocking", async () => {
    const { port, count } = await unwelcoming();
    await expect(
      mqttCarrier({ kind: "mqtt", url: `ws://127.0.0.1:${port}` }, "topic"),
    ).rejects.toThrow();
    const knocks = count();
    expect(knocks).toBeGreaterThanOrEqual(1);
    // The old reconnect period was 3 s; wait past two of them.
    await new Promise((resolve) => setTimeout(resolve, 6500));
    expect(count()).toBe(knocks);
  }, 15_000);
});
