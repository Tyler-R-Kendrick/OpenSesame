/**
 * A throwaway certificate for the carrier the netns walks run on a private
 * address. Routes takes a carrier on any address other than this device's own
 * only over `wss://`, so the test relay must speak TLS; no browser here has a
 * CA that would vouch for it. The certificate is for that one IP, and the
 * browsers are told to accept exactly its public key
 * (`--ignore-certificate-errors-spki-list`) — not to ignore certificate errors
 * in general.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function openssl(args, input) {
  return execFileSync("openssl", args, {
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** `{ key, cert, spki }` for a self-signed P-256 certificate valid for `ip`. */
export function certificateFor(ip) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-netns-tls-"));
  try {
    const keyFile = path.join(dir, "key.pem");
    const certFile = path.join(dir, "cert.pem");
    openssl([
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${ip}`,
      "-addext",
      `subjectAltName=IP:${ip}`,
      "-keyout",
      keyFile,
      "-out",
      certFile,
    ]);
    const cert = fs.readFileSync(certFile);
    const pub = openssl(["x509", "-pubkey", "-noout"], cert);
    const der = openssl(["pkey", "-pubin", "-outform", "der"], pub);
    const digest = openssl(["dgst", "-sha256", "-binary"], der);
    return {
      key: fs.readFileSync(keyFile),
      cert,
      spki: digest.toString("base64"),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
