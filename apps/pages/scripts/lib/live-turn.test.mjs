import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { mintTurnCert, startLiveTurn } from "./live-turn.mjs";

/** A public certificate the stand-in's `mint` writes, so the reader has one. */
const CERT = `-----BEGIN CERTIFICATE-----
MIIBmDCCAT6gAwIBAgIURB+YGhWUi9r6XrfJt2cm9gaZmlQwCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwObGl2ZS10dXJuLXRlc3QwHhcNMjYxMDI0MTU1MTI1WhcNMzYx
MDIxMTU1MTI1WjAZMRcwFQYDVQQDDA5saXZlLXR1cm4tdGVzdDBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABEc0pdf1TfbSHjfyYePVhggoLdvbPihMkBv4dHCXX8Ju
Fh9DFHGnY09YpndVGf4owG/nP/JJC0ymAYcWvoYi0vajZDBiMB0GA1UdDgQWBBQU
o3SVdLiEfQq0Etj24GWv93H75jAfBgNVHSMEGDAWgBQUo3SVdLiEfQq0Etj24GWv
93H75jAPBgNVHRMBAf8EBTADAQH/MA8GA1UdEQQIMAaHBH8AAAEwCgYIKoZIzj0E
AwIDSAAwRQIhAMwaSSQRD+8LAuW0Sz60M/jC+MtfAK1b8QU5fZg+QV0BAiB3KIi4
39J9W1kHCDd77ig2gBxICMA8s6Ff+7MMZk/Mrg==
-----END CERTIFICATE-----
`;

const made = [];

afterEach(() => {
  for (const dir of made.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A stand-in for the live-turn binary: it keeps the arguments it was given,
 * writes cert.pem for `mint`, and for `serve` says it is ready on fixed ports
 * and waits to be stopped.
 */
function standIn() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-turn-stand-in-"));
  made.push(dir);
  const binary = path.join(dir, "live-turn");
  const kept = path.join(dir, "args.json");
  fs.writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(kept)}, JSON.stringify(args));
if (args[0] === "mint") {
  fs.writeFileSync(path.join(args[1], "cert.pem"), ${JSON.stringify(CERT)});
} else {
  const tls = args.includes("-cert") ? 5349 : 0;
  console.log(JSON.stringify({ ready: true, udp: 3478, tcp: 3479, tls, stats: 9 }));
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
}
`,
    { mode: 0o755 },
  );
  return { binary, args: () => JSON.parse(fs.readFileSync(kept, "utf8")) };
}

function after(flag, args) {
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args[at + 1];
}

test("the server listens on the address it is given, and is named there", async () => {
  const fake = standIn();
  const turn = await startLiveTurn(fake.binary, { host: "192.0.2.7" });
  try {
    assert.equal(after("-host", fake.args()), "192.0.2.7");
    assert.deepEqual(turn.urls, {
      udp: "turn:192.0.2.7:3478?transport=udp",
      tcp: "turn:192.0.2.7:3479?transport=tcp",
      tls: null,
    });
  } finally {
    await turn.stop();
  }
});

test("TLS is named at that address too, and loopback is the default", async () => {
  const fake = standIn();
  const cert = { cert: "cert.pem", key: "key.pem" };
  const named = await startLiveTurn(fake.binary, { cert, host: "192.0.2.7" });
  await named.stop();
  assert.equal(named.urls.tls, "turns:192.0.2.7:5349?transport=tcp");
  const plain = await startLiveTurn(fake.binary);
  await plain.stop();
  assert.equal(after("-host", fake.args()), "127.0.0.1");
  assert.equal(plain.urls.udp, "turn:127.0.0.1:3478?transport=udp");
});

test("the certificate is minted for the address the server listens on", () => {
  const fake = standIn();
  const minted = mintTurnCert(fake.binary, "192.0.2.7");
  made.push(path.dirname(minted.cert));
  const [verb, dir, host] = fake.args();
  assert.equal(verb, "mint");
  assert.equal(dir, path.dirname(minted.cert));
  assert.equal(host, "192.0.2.7");
  assert.match(minted.flag, /^--ignore-certificate-errors-spki-list=\S+=$/);
  const bare = mintTurnCert(fake.binary);
  made.push(path.dirname(bare.cert));
  assert.equal(fake.args().length, 2);
});

test("a missing binary is reported, never faked", async () => {
  const missing = path.join(os.tmpdir(), "no-live-turn-here");
  assert.deepEqual(mintTurnCert(missing, "192.0.2.7"), { missing });
  assert.deepEqual(await startLiveTurn(missing, { host: "192.0.2.7" }), {
    missing,
  });
});
