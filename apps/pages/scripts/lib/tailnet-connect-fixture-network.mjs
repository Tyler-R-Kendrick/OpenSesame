import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { connect, isIP } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { command } from "./tailnet-connect-fixture-process.mjs";

const TLSErrorCode = z
  .string()
  .regex(/^[A-Z0-9_]{1,80}$/)
  .catch("TLS_ERROR");

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-allow-private-network": "true",
};

export async function fixtureTls(
  directory,
  {
    subjectAltName = "DNS:derp.fixture.test,DNS:localhost,IP:127.0.0.1",
    issuerDirectory = directory,
  } = {},
) {
  const at = (name) => join(directory, name);
  const issuerAt = (name) => join(issuerDirectory, name);
  if (issuerDirectory === directory) {
    await command("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-keyout",
      at("ca.key"),
      "-out",
      at("ca.pem"),
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-subj",
      "/CN=Tailnet browser fixture CA",
    ]);
  }
  await command("openssl", [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    at("derp.key"),
    "-out",
    at("derp.csr"),
    "-subj",
    "/CN=derp.fixture.test",
  ]);
  await writeFile(
    at("tls.ext"),
    [
      `subjectAltName=${subjectAltName}`,
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
    ].join("\n"),
  );
  await command("openssl", [
    "x509",
    "-req",
    "-in",
    at("derp.csr"),
    "-CA",
    issuerAt("ca.pem"),
    "-CAkey",
    issuerAt("ca.key"),
    "-CAcreateserial",
    "-out",
    at("derp.pem"),
    "-days",
    "2",
    "-extfile",
    at("tls.ext"),
  ]);
  await command("openssl", [
    "pkey",
    "-in",
    at("derp.key"),
    "-pubout",
    "-outform",
    "DER",
    "-out",
    at("spki.der"),
  ]);
  return {
    key: await readFile(at("derp.key")),
    cert: await readFile(at("derp.pem")),
    caPath: issuerAt("ca.pem"),
    spki: createHash("sha256")
      .update(await readFile(at("spki.der")))
      .digest("base64"),
  };
}

/** Test-only peer keys remain in Node; callers expose only the public CA PEM. */
export async function fixturePeerTLS(directory, address) {
  if (!isIP(address))
    throw new Error("Peer TLS fixture needs a real IP address");
  const issuerDirectory = join(directory, "peer-tls");
  const mismatchDirectory = join(directory, "peer-tls-wrong-host");
  await mkdir(issuerDirectory);
  await mkdir(mismatchDirectory);
  const trusted = await fixtureTls(issuerDirectory, {
    subjectAltName: `IP:${address}`,
  });
  const wrongHostname = await fixtureTls(mismatchDirectory, {
    subjectAltName: "DNS:wrong-peer.fixture.test",
    issuerDirectory,
  });
  return {
    trusted,
    wrongHostname,
    caPEM: await readFile(trusted.caPath, "utf8"),
  };
}

function proxyHttp(port, records) {
  return (incoming, response) => {
    records.push({
      kind: "http",
      method: incoming.method,
      path: new URL(incoming.url, "http://fixture").pathname,
    });
    if (incoming.method === "OPTIONS") {
      response.writeHead(204, CORS).end();
      return;
    }
    const upstream = request(
      {
        host: "127.0.0.1",
        port,
        path: incoming.url,
        method: incoming.method,
        headers: incoming.headers,
      },
      (reply) => {
        response.writeHead(reply.statusCode, { ...reply.headers, ...CORS });
        reply.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    incoming.pipe(upstream);
  };
}

function proxyUpgrade(port, records) {
  return (incoming, socket, head) => {
    const path = new URL(incoming.url, "http://fixture").pathname;
    records.push({
      kind: "upgrade",
      path,
      subprotocol: incoming.headers["sec-websocket-protocol"] ?? "",
    });
    const upstream = connect(port, "127.0.0.1", () => {
      const headers = [];
      for (let index = 0; index < incoming.rawHeaders.length; index += 2)
        headers.push(
          `${incoming.rawHeaders[index]}: ${incoming.rawHeaders[index + 1]}`,
        );
      upstream.write(
        `${incoming.method} ${incoming.url} HTTP/${incoming.httpVersion}\r\n${headers.join("\r\n")}\r\n\r\n`,
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    let sent = 0;
    let received = 0;
    socket.on("data", (bytes) => {
      sent += bytes.length;
    });
    upstream.on("data", (bytes) => {
      received += bytes.length;
    });
    socket.on("close", () => {
      records.push({ kind: "socket-close", path, sent, received });
      upstream.destroy();
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  };
}

async function listening(server, port) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return () =>
    new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(resolve);
    });
}

export async function forwardingEdge({ port, upstreamPort, records, tls }) {
  const handler = proxyHttp(upstreamPort, records);
  const server = tls ? createTlsServer(tls, handler) : createServer(handler);
  server.on("upgrade", proxyUpgrade(upstreamPort, records));
  return listening(server, port);
}

export async function proofServer(port, tls) {
  const nonce = randomUUID();
  const requests = [];
  const handler = (incoming, response) => {
    const path = new URL(incoming.url, "http://peer").pathname;
    requests.push({ method: incoming.method, path });
    response.writeHead(path === "/proof" ? 200 : 404, {
      "content-type": "application/json",
    });
    response.end(
      JSON.stringify({ source: "real-native-tailscale-peer", nonce, path }),
    );
  };
  const server = tls ? createTlsServer(tls, handler) : createServer(handler);
  const stats = tls
    ? { connections: 0, secure: 0, errors: 0, lastError: "" }
    : null;
  if (stats) {
    server.on("connection", () => stats.connections++);
    server.on("secureConnection", () => stats.secure++);
    server.on("tlsClientError", (error) => {
      stats.errors++;
      // An error code distinguishes rejection from cancellation without logging
      // certificate contents or unbounded native error messages.
      stats.lastError = TLSErrorCode.parse(error.code);
    });
  }
  const close = await listening(server, port);
  return {
    nonce,
    requests,
    stats,
    origin: `${tls ? "https" : "http"}://127.0.0.1:${server.address().port}`,
    close,
  };
}
