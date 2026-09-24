#!/usr/bin/env node
/**
 * Local HTTPS front door for Connect OAuth callbacks.
 *
 * Some providers only accept https callback URLs, which loopback cannot
 * give them. This script terminates TLS for `<lan-ip>.nip.io` (plain DNS
 * that resolves to this machine, no account needed) with a throwaway
 * self-signed certificate, and forwards:
 *
 *   /api/connect/*  → the relay (`apps/connect-backend`, plain http)
 *   everything else  → Vite (`apps/pages`, plain http, HMR upgrade kept)
 *
 * Trust is a manual step, once per certificate: open the https URL in the
 * browser you approve OAuth in and accept the warning. The approval itself
 * still happens on the provider's real HTTPS — only the callback leg rides
 * this certificate.
 *
 *   node scripts/dev/connect-dev-proxy.mjs [--https-port 8443]
 *     [--app-port 5180] [--relay-port 8789]
 *
 * Prints the two values the session needs:
 *   VITE_CONNECT_CALLBACK_BASE=https://<lan-ip>.nip.io:8443
 *   OPENSESAME_CONNECT_APP_ORIGINS=http://localhost:5180
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const HTTPS_PORT = Number(flag("https-port", "8443"));
const APP_PORT = Number(flag("app-port", "5180"));
const RELAY_PORT = Number(flag("relay-port", "8789"));

function lanIp() {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}

const IP = process.env.DEV_LAN_IP ?? lanIp();
const HOST = `${IP}.nip.io`;
const STATE = join(tmpdir(), "opensesame-connect-proxy");
mkdirSync(STATE, { recursive: true });
const KEY = join(STATE, "key.pem");
const CERT = join(STATE, "cert.pem");

if (!existsSync(KEY) || !existsSync(CERT)) {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "30",
      "-keyout",
      KEY,
      "-out",
      CERT,
      "-subj",
      "/CN=opensesame-connect-dev",
      "-addext",
      `subjectAltName=DNS:${HOST},DNS:localhost,IP:${IP},IP:127.0.0.1`,
    ],
    { stdio: "inherit" },
  );
}

const { readFileSync } = await import("node:fs");
const credentials = {
  key: readFileSync(KEY),
  cert: readFileSync(CERT),
};

function forward(clientReq, clientRes, port) {
  const proxyReq = httpRequest(
    {
      host: "127.0.0.1",
      port,
      path: clientReq.url,
      method: clientReq.method,
      headers: { ...clientReq.headers, host: `127.0.0.1:${port}` },
    },
    (proxyRes) => {
      clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(clientRes);
    },
  );
  proxyReq.on("error", () => {
    clientRes.writeHead(502, { "content-type": "text/plain" });
    clientRes.end("Upstream is not running.");
  });
  clientReq.pipe(proxyReq);
}

const server = createHttpsServer(credentials, (req, res) => {
  const url = new URL(req.url ?? "/", "https://relay.invalid");
  if (url.pathname.startsWith("/api/connect/")) {
    forward(req, res, RELAY_PORT);
    return;
  }
  forward(req, res, APP_PORT);
});

// Vite HMR rides an upgraded socket; drop it and the page goes stale.
server.on("upgrade", (req, socket, head) => {
  const proxyReq = httpRequest({
    host: "127.0.0.1",
    port: APP_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${APP_PORT}` },
  });
  proxyReq.on("error", () => socket.destroy());
  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    socket.write(
      `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`,
    );
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (value !== undefined) socket.write(`${key}: ${value}\r\n`);
    }
    socket.write("\r\n");
    if (proxyHead?.length) proxySocket.unshift(proxyHead);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });
  if (head?.length) proxyReq.write(head);
  req.pipe(proxyReq);
});

server.listen(HTTPS_PORT, "0.0.0.0", () => {
  console.log(`callback base: https://${HOST}:${HTTPS_PORT}`);
  console.log(`VITE_CONNECT_CALLBACK_BASE=https://${HOST}:${HTTPS_PORT}`);
  console.log(`OPENSESAME_CONNECT_APP_ORIGINS=http://localhost:${APP_PORT}`);
  console.log(
    "First visit the https URL once in the approving browser and accept the dev certificate.",
  );
});
