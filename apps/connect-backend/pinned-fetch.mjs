/**
 * A minimal `fetch` for one forge origin whose DNS answers were already
 * vetted (`forge-host-guard.mjs`). The global `fetch` would resolve the name
 * again when it connects, so a rebinding resolver could answer the check with
 * a public address and the connection with a private one. Here the socket's
 * `lookup` answers only from the vetted list: TLS still verifies the
 * certificate for the name (SNI and `Host` keep the hostname), but the TCP
 * connection can only reach an address that passed the check.
 *
 * Only what the relay's forge calls use is implemented: method, headers, a
 * string body, `redirect: "error"`, and `{ ok, status, text() }` back. A
 * redirect is never followed.
 */

import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

const TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function wantedFamily(options) {
  const family = options?.family;
  if (family === 4 || family === "IPv4") return 4;
  if (family === 6 || family === "IPv6") return 6;
  return 0;
}

/**
 * A `net.connect` `lookup` that ignores the resolver and answers only with
 * `addresses` (`[{ address, family }]`), whatever name it is asked for.
 */
export function pinnedLookup(addresses) {
  const vetted = addresses
    .map((entry) => ({
      address: String(entry.address),
      family: isIP(String(entry.address)),
    }))
    .filter((entry) => entry.family !== 0);
  // `net.connect` calls `lookup(hostname, options, callback)`; a two-argument
  // call has no options.
  return (hostname, options, callback) => {
    const done = callback ?? options;
    const opts = callback ? (options ?? {}) : {};
    const family = wantedFamily(opts);
    const usable = vetted.filter((entry) => !family || entry.family === family);
    if (usable.length === 0) {
      const error = new Error(`No vetted address for ${hostname}`);
      error.code = "ENOTFOUND";
      done(error);
      return;
    }
    if (opts.all) done(null, usable);
    else done(null, usable[0].address, usable[0].family);
  };
}

/** The `https.request` options for `url`, connecting only to `addresses`. */
export function pinnedRequestOptions(url, init, addresses) {
  const target = new URL(url);
  if (target.protocol !== "https:") {
    throw new Error("Pinned forge requests are https only.");
  }
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const body = init.body === undefined ? undefined : String(init.body);
  const headers = { ...(init.headers ?? {}), host: target.host };
  if (body !== undefined) headers["content-length"] = Buffer.byteLength(body);
  const options = {
    protocol: "https:",
    hostname,
    port: target.port || 443,
    path: `${target.pathname}${target.search}`,
    method: init.method ?? "GET",
    headers,
    lookup: pinnedLookup(addresses),
    agent: false,
    timeout: TIMEOUT_MS,
  };
  if (!isIP(hostname)) options.servername = hostname;
  return { options, body };
}

function readResponse(response, init, resolve, reject) {
  const status = response.statusCode ?? 0;
  if (status >= 300 && status < 400 && init.redirect === "error") {
    response.destroy();
    reject(new Error("Forge redirect refused."));
    return;
  }
  const chunks = [];
  let size = 0;
  response.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) {
      response.destroy(new Error("Forge response too large."));
      return;
    }
    chunks.push(chunk);
  });
  response.on("error", reject);
  response.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    resolve({
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    });
  });
}

/** A fetch-shaped function whose connections reach only `addresses`. */
export function createPinnedFetch(addresses, requestImpl = httpsRequest) {
  return (url, init = {}) =>
    new Promise((resolve, reject) => {
      const { options, body } = pinnedRequestOptions(url, init, addresses);
      const req = requestImpl(options, (response) =>
        readResponse(response, init, resolve, reject),
      );
      req.on("timeout", () => req.destroy(new Error("Forge timed out.")));
      req.on("error", reject);
      req.end(body);
    });
}
