/**
 * The TURN server the relayed walks use for TCP and TLS (ADR 0150 §6):
 * `live-turn`, a pion/turn server (scripts/test/live-turn, built into
 * .cache/live-fixtures/bin by `pnpm test:live-fixtures`) that speaks UDP, TCP
 * and TLS at once and says, over a control endpoint, what each transport saw.
 * node-turn, which the UDP walk keeps, is UDP only.
 *
 * TLS needs a certificate a browser will take: `mintTurnCert` has the binary
 * write a throwaway self-signed one and returns the SHA-256 of its public key,
 * which Chromium is told to trust and nothing else
 * (`--ignore-certificate-errors-spki-list`). A missing binary is reported,
 * never faked.
 */

import { execFileSync, spawn } from "node:child_process";
import { X509Certificate, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A throwaway certificate for 127.0.0.1, and the flag that trusts only it. */
export function mintTurnCert(binary) {
  if (!binary || !fs.existsSync(binary)) return { missing: binary };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-turn-cert-"));
  execFileSync(binary, ["mint", dir]);
  const cert = path.join(dir, "cert.pem");
  const key = new X509Certificate(fs.readFileSync(cert)).publicKey.export({
    type: "spki",
    format: "der",
  });
  const spki = createHash("sha256").update(key).digest("base64");
  return {
    cert,
    key: path.join(dir, "key.pem"),
    flag: `--ignore-certificate-errors-spki-list=${spki}`,
  };
}

function firstLine(child, ms) {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const timer = setTimeout(
      () => reject(new Error(`live-turn never said it was ready\n${err}`)),
      ms,
    );
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(`live-turn exited (${code}) before it was ready\n${err}`),
      );
    });
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (!out.includes("\n")) return;
      clearTimeout(timer);
      resolve(JSON.parse(out.split("\n")[0]));
    });
  });
}

/**
 * Serve TURN on loopback UDP, TCP and (with `cert`) TLS, on ports the kernel
 * chose. `urls` are the ICE server URLs a person types into Routes. With
 * `restSecret` the server takes TURN REST credentials minted from that secret
 * (coturn's `use-auth-secret`) instead of a static name and credential.
 */
export async function startLiveTurn(binary, { cert, restSecret } = {}) {
  if (!binary || !fs.existsSync(binary)) return { missing: binary };
  const username = "live";
  const credential = randomBytes(12).toString("hex");
  const args = restSecret
    ? ["serve", "-rest-secret", restSecret]
    : ["serve", "-user", username, "-credential", credential];
  if (cert) args.push("-cert", cert.cert, "-key", cert.key);
  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  let ready;
  try {
    ready = await firstLine(child, 15_000);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  const url = `http://127.0.0.1:${ready.stats}/stats`;
  return {
    username: restSecret ? undefined : username,
    credential: restSecret ? undefined : credential,
    urls: {
      udp: `turn:127.0.0.1:${ready.udp}?transport=udp`,
      tcp: `turn:127.0.0.1:${ready.tcp}?transport=tcp`,
      tls: ready.tls ? `turns:127.0.0.1:${ready.tls}?transport=tcp` : null,
    },
    /** What each transport saw so far: { udp, tcp, tls } of counters. */
    stats: async () => (await fetch(url)).json(),
    stop: () =>
      new Promise((resolve) => {
        child.removeAllListeners("exit");
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}
