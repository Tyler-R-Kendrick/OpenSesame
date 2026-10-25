/** Test-only TLS with exact Google DNS names and one pinned ephemeral public key. */
import { execFileSync } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const GOOGLE_WALLET_HOSTS = [
  "oauth2.googleapis.com",
  "walletobjects.googleapis.com",
  "pay.google.com",
];
export function googleWalletCertificate(hosts = GOOGLE_WALLET_HOSTS) {
  const directory = mkdtempSync(join(tmpdir(), "google-wallet-browser-tls-"));
  try {
    const key = join(directory, "key.pem");
    const cert = join(directory, "cert.pem");
    execFileSync(
      "openssl",
      [
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
        `/CN=${hosts[0]}`,
        "-addext",
        `subjectAltName=${hosts.map((name) => `DNS:${name}`).join(",")},IP:127.0.0.1`,
        "-keyout",
        key,
        "-out",
        cert,
      ],
      { stdio: "ignore" },
    );
    const certificate = new X509Certificate(readFileSync(cert));
    return {
      key: readFileSync(key),
      cert: readFileSync(cert),
      spki: createHash("sha256")
        .update(certificate.publicKey.export({ type: "spki", format: "der" }))
        .digest("base64"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
export function googleWalletBrowserArguments(port, spki) {
  return [
    "--no-proxy-server",
    `--host-resolver-rules=${GOOGLE_WALLET_HOSTS.map((name) => `MAP ${name} 127.0.0.1:${port}`).join(", ")}`,
    `--ignore-certificate-errors-spki-list=${spki}`,
  ];
}
