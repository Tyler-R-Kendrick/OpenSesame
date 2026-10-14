import type { AddressInfo } from "node:net";

/** Port from `server.listen(host, port)` after ruling out a pipe path or missing bind. */
export function tcpListenPort(address: AddressInfo): number | null {
  const port = address.port;
  return Number.isFinite(port) ? port : null;
}
