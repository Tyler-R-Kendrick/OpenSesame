/**
 * Disposable test PKI, generated per test file in a temp directory with the
 * system `openssl` CLI (3.0.x here) and deleted afterwards. Nothing is
 * committed, and every key is a throwaway P-256.
 *
 * `openssl` is an oracle independent of Node's X.509 code, which is why it
 * is preferred over an in-process builder for these tests.
 */
import { execFileSync } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Issued {
  name: string;
  certPath: string;
  keyPath: string;
  certPem: string;
  keyPem: string;
  cert: X509Certificate;
  /** Lowercase hex SHA-256 of the DER (the `leaf_thumbprint_sha256` selector). */
  thumbHex: string;
  /** base64url SHA-256 of the DER (the `cnf["x5t#S256"]` value). */
  thumbB64u: string;
}

export interface ClientSpec {
  dns?: string[];
  uri?: string[];
  /** Reuse another leaf's private key (AT-OAUTH-SWAP certificate C). */
  reuseKeyOf?: Issued;
  days?: number;
  /** Issue as a CA certificate (to test CA-as-leaf rejection). */
  ca?: boolean;
}

export interface DisposablePki {
  dir: string;
  caCertPath: string;
  caKeyPath: string;
  caCertPem: string;
  ca: X509Certificate;
  issueServer(name: string, sans?: string[]): Issued;
  issueClient(name: string, spec?: ClientSpec): Issued;
  /** Another, unrelated root: certificates under it are "untrusted". */
  otherCa(): DisposablePki;
  cleanup(): void;
}

function openssl(args: string[], cwd: string): void {
  execFileSync("openssl", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
}

let serial = 0x1000;

function build(dir: string, caName: string): DisposablePki {
  const caKeyPath = join(dir, `${caName}.key`);
  const caCertPath = join(dir, `${caName}.crt`);
  openssl(
    ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", caKeyPath],
    dir,
  );
  openssl(
    [
      "req",
      "-x509",
      "-new",
      "-key",
      caKeyPath,
      "-days",
      "2",
      "-subj",
      `/CN=${caName}`,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-out",
      caCertPath,
    ],
    dir,
  );
  const caCertPem = readFileSync(caCertPath, "utf8");

  function issue(
    name: string,
    ext: string,
    days: number,
    keyPathOverride?: string,
  ): Issued {
    const keyPath = keyPathOverride ?? join(dir, `${name}.key`);
    const csrPath = join(dir, `${name}.csr`);
    const extPath = join(dir, `${name}.ext`);
    const certPath = join(dir, `${name}.crt`);
    if (!keyPathOverride) {
      openssl(
        [
          "ecparam",
          "-name",
          "prime256v1",
          "-genkey",
          "-noout",
          "-out",
          keyPath,
        ],
        dir,
      );
    }
    openssl(
      ["req", "-new", "-key", keyPath, "-subj", `/CN=${name}`, "-out", csrPath],
      dir,
    );
    writeFileSync(extPath, ext);
    serial += 1;
    openssl(
      [
        "x509",
        "-req",
        "-in",
        csrPath,
        "-CA",
        caCertPath,
        "-CAkey",
        caKeyPath,
        "-set_serial",
        String(serial),
        "-days",
        String(days),
        "-extfile",
        extPath,
        "-out",
        certPath,
      ],
      dir,
    );
    const certPem = readFileSync(certPath, "utf8");
    const cert = new X509Certificate(certPem);
    return {
      name,
      certPath,
      keyPath,
      certPem,
      keyPem: readFileSync(keyPath, "utf8"),
      cert,
      thumbHex: createHash("sha256").update(cert.raw).digest("hex"),
      thumbB64u: createHash("sha256").update(cert.raw).digest("base64url"),
    };
  }

  return {
    dir,
    caCertPath,
    caKeyPath,
    caCertPem,
    ca: new X509Certificate(caCertPem),
    issueServer(name, sans = ["DNS:localhost", "IP:127.0.0.1"]) {
      return issue(
        name,
        `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=${sans.join(",")}\n`,
        1,
      );
    },
    issueClient(name, spec = {}) {
      const sans = [
        ...(spec.dns ?? []).map((d) => `DNS:${d}`),
        ...(spec.uri ?? []).map((u) => `URI:${u}`),
      ];
      const lines = [
        spec.ca
          ? "basicConstraints=critical,CA:TRUE"
          : "basicConstraints=CA:FALSE",
        "keyUsage=digitalSignature",
        "extendedKeyUsage=clientAuth",
        ...(sans.length > 0 ? [`subjectAltName=${sans.join(",")}`] : []),
      ];
      return issue(
        name,
        `${lines.join("\n")}\n`,
        spec.days ?? 1,
        spec.reuseKeyOf?.keyPath,
      );
    },
    otherCa() {
      return build(mkdtempSync(join(dir, "other-")), "other-ca");
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function createDisposablePki(name = "test-ca"): DisposablePki {
  return build(mkdtempSync(join(tmpdir(), "os-mtls-")), name);
}

/** Write a `ServiceBindingSet` document next to the PKI and return its path. */
export function writeBindings(pki: DisposablePki, bindings: object): string {
  const path = join(pki.dir, `bindings-${serial}.json`);
  writeFileSync(path, JSON.stringify(bindings));
  return path;
}
