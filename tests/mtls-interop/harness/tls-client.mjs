#!/usr/bin/env node
/**
 * A Node `tls.connect` client, used as an independent runtime against the
 * Rust `SecureListener` (IOP-TLS).
 *
 * Node and rustls disagree about almost nothing that matters here, which is
 * the point: when Node's OpenSSL refuses the same certificate rustls refuses,
 * the refusal is a property of the certificate.
 *
 * Configuration is environment-only so no argument parsing can be confused
 * with a URL. Nothing is ever written; the script prints one JSON line:
 *
 *   {"handshake":"ok"|"failed","authorized":bool,"protocol":"TLSv1.3",
 *    "status":200,"code":"ERR_TLS_..."}
 *
 * `handshake:"failed"` and `status` are mutually exclusive, so the caller can
 * tell a TLS refusal from a post-handshake authorization denial.
 *
 * Certificate verification is never disabled: there is no
 * `rejectUnauthorized:false` here and there must never be one.
 */
import { readFileSync } from "node:fs";
import tls from "node:tls";

const env = process.env;
const port = Number(env.IOP_PORT);
const host = "127.0.0.1";
const servername = env.IOP_SERVERNAME ?? "host.iop.test";
const requestPath = env.IOP_PATH ?? "/";
const timeoutMs = Number(env.IOP_TIMEOUT_MS ?? 15000);

function out(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
  process.exit(0);
}

if (!Number.isInteger(port) || port <= 0) {
  out({ handshake: "failed", code: "IOP_PORT_MISSING" });
}

const options = {
  host,
  port,
  servername,
  minVersion: env.IOP_MIN_VERSION === "1.2" ? "TLSv1.2" : "TLSv1.3",
  ca: readFileSync(env.IOP_CA_FILE, "utf8"),
  ALPNProtocols: ["http/1.1"],
};
if (env.IOP_CERT_FILE && env.IOP_KEY_FILE) {
  options.cert = readFileSync(env.IOP_CERT_FILE, "utf8");
  options.key = readFileSync(env.IOP_KEY_FILE, "utf8");
}
if (env.IOP_CHECK_SERVER_IDENTITY === "skip-name") {
  // Issuer verification stays on; only the *name* check is relaxed, so a
  // test can isolate "wrong issuer" from "wrong name". Never a blanket
  // `rejectUnauthorized:false`.
  options.checkServerIdentity = () => undefined;
}

const socket = tls.connect(options);
let body = "";
// `getProtocol()` and `authorized` are only meaningful while the socket is
// up; reading them in `close` returns null. Capture them on secureConnect.
let protocol = null;
let authorized = false;
const timer = setTimeout(() => {
  socket.destroy();
  out({ handshake: "failed", code: "IOP_TIMEOUT" });
}, timeoutMs);

socket.on("secureConnect", () => {
  protocol = socket.getProtocol();
  authorized = socket.authorized === true;
  socket.write(
    `GET ${requestPath} HTTP/1.1\r\nHost: ${servername}\r\nConnection: close\r\n\r\n`,
  );
});
socket.on("data", (chunk) => {
  body += chunk.toString("utf8");
});
socket.on("error", (error) => {
  clearTimeout(timer);
  out({
    handshake: "failed",
    code: error.code ?? "ERR_UNKNOWN",
    message: String(error.message ?? "").slice(0, 200),
  });
});
socket.on("close", () => {
  clearTimeout(timer);
  const first = body.split("\r\n", 1)[0] ?? "";
  const status = Number(first.split(" ")[1]);
  out({
    handshake: body ? "ok" : "failed",
    authorized,
    protocol,
    ...(Number.isInteger(status) ? { status } : {}),
    ...(body ? {} : { code: "IOP_NO_APPLICATION_DATA" }),
  });
});
