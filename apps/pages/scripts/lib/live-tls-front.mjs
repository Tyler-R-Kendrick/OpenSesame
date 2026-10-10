/**
 * TLS in front of a server the live walk runs on loopback (ADR 0150 §6).
 *
 * The app lets a carrier be plain (`ws://`, `http://`) only on this device
 * (`isCarrierUrl`): a page served over https may not open a plain socket
 * anywhere else. Chromium and Firefox let a page on https reach loopback
 * plainly; WebKit, as Safari does, refuses it as mixed content. So where a
 * pair holds an engine that does (`lacks(engine, "plain-loopback-socket")`),
 * each carrier is reached the way it is in production, over TLS: this
 * terminates TLS in front of the server and passes the bytes through, so the
 * server is the same server and sees the same frames.
 *
 * The certificate is the walk's throwaway one (`mintTurnCert`, for
 * 127.0.0.1). Chromium trusts its public key and nothing else; Firefox and
 * WebKit are told to accept TLS errors on the page's own sockets and fetches
 * (`ignoreHTTPSErrors`), which is all that option reaches.
 */

import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { lacks } from "./live-engines.mjs";

/** Whether a pair of `engines` has to reach its carriers over TLS. */
export function needsTls(engines) {
  return engines.some((engine) => lacks(engine, "plain-loopback-socket"));
}

/**
 * `server` (anything with a plain `url` and a `stop`) behind TLS: the same
 * object, its `url` now `wss://` or `https://` on the front's port, and its
 * `stop` closing the front first.
 */
export async function tlsFront(server, cert) {
  if (!cert?.cert || !cert?.key)
    throw new Error(
      "a TLS front needs the walk's certificate (live-turn mint)",
    );
  const target = new URL(server.url);
  const sockets = new Set();
  const front = tls.createServer(
    { cert: fs.readFileSync(cert.cert), key: fs.readFileSync(cert.key) },
    (client) => {
      const upstream = net.connect(Number(target.port), target.hostname);
      sockets.add(client).add(upstream);
      const end = () => {
        client.destroy();
        upstream.destroy();
        sockets.delete(client);
        sockets.delete(upstream);
      };
      for (const side of [client, upstream]) {
        side.on("error", end);
        side.on("close", end);
      }
      client.pipe(upstream);
      upstream.pipe(client);
    },
  );
  await new Promise((resolve, reject) => {
    front.once("error", reject);
    front.listen(0, target.hostname, resolve);
  });
  const { port } = front.address();
  const url = server.url
    .replace(/^ws:/, "wss:")
    .replace(/^http:/, "https:")
    .replace(`:${target.port}`, `:${port}`);
  return {
    ...server,
    url,
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => front.close(() => resolve()));
      await server.stop();
    },
  };
}

/** `server` as the pair of `engines` has to reach it: over TLS, or as it is. */
export function reachableBy(server, engines, cert) {
  return needsTls(engines) ? tlsFront(server, cert) : server;
}
