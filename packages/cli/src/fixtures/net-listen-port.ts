import type { AddressInfo } from "node:net";

/** Port from `server.listen(host, port)`; `null` when the socket has no TCP address yet. */
export function tcpListenPort(
  address: string | AddressInfo | null,
): number | null {
  if (address === null) return null;
  if (!("port" in address)) return null;
  const port = address.port;
  return Number.isFinite(port) ? port : null;
}
