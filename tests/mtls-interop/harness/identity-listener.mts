/**
 * The Identity plane's **real** TLS listener, started out of process so a
 * Rust client can dial it (IOP-TLS).
 *
 * Nothing is reimplemented here: `loadTransportConfig`,
 * `loadTransportMaterial`, `createTransportListener`, `peerOf`,
 * `parseServiceBindings` and `admitService` are the shipped
 * `apps/control-plane/src/transport` modules. This file only supplies a raw
 * dispatcher so the two outcomes are visible from the wire:
 *
 *   * the handshake completed and admission allowed the operation → `200`
 *   * the handshake completed and admission refused → `403` plus the stable
 *     `TransportError` code in `x-opensesame-transport-error`
 *
 * A handshake that never completes produces neither, which is what lets a
 * caller tell a TLS refusal from an authorization denial.
 *
 * Configuration is the deployment-plane environment the Identity plane
 * already documents (`OPENSESAME_TLS_*`, `OPENSESAME_SERVICE_BINDINGS_FILE`).
 * The bound port is printed as one JSON line on stdout; the process then
 * serves until it is killed.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  admitService,
  createTransportListener,
  loadTransportConfig,
  loadTransportMaterial,
  peerOf,
} from "../../../apps/control-plane/src/transport/index.js";

const config = loadTransportConfig(process.env);
if (!config.listener) {
  process.stderr.write("OPENSESAME_TLS_LISTEN is required\n");
  process.exit(2);
}
const material = loadTransportMaterial(config.listener);

/** `/probe/<operation>` — admit, then require that exact operation. */
function dispatch(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? "/";
  const operation = url.startsWith("/probe/")
    ? decodeURIComponent(url.slice("/probe/".length))
    : "";
  const peer = peerOf(req.socket);
  if (!peer) {
    res.writeHead(403, {
      "content-type": "text/plain",
      "x-opensesame-transport-error": "peer_not_bound",
    });
    res.end("peer_not_bound");
    return;
  }
  const result = admitService(
    listener.bindings(),
    peer,
    "nats_auth_bridge",
    operation,
    new Date(),
  );
  if (!result.ok) {
    res.writeHead(403, {
      "content-type": "text/plain",
      "x-opensesame-transport-error": result.code,
    });
    res.end(result.code);
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(
    `admitted ${result.caller.binding.service_principal} ${peer.leafThumbprintSha256()}`,
  );
}

const listener = createTransportListener({
  config: config.listener,
  material,
  dispatch,
});

const address = await listener.start();
process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void listener.close().then(() => process.exit(0));
  });
}
