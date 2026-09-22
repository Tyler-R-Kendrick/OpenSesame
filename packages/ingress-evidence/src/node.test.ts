import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type HeaderPair, parseClientCertFields } from "./index.js";
import { OriginatingChainError, verifyOriginatingChain } from "./node.js";

/** A disposable PKI made with the openssl CLI (an oracle independent of Node), deleted after the run. */
let dir: string;
const openssl = (...args: string[]) =>
  execFileSync("openssl", args, {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });

function ca(name: string, issuer?: string) {
  openssl(
    "req",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.csr`,
    "-subj",
    `/CN=${name}`,
  );
  writeFileSync(
    join(dir, `${name}.ext`),
    "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n",
  );
  if (issuer) {
    openssl(
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      `${issuer}.pem`,
      "-CAkey",
      `${issuer}.key`,
      "-CAcreateserial",
      "-out",
      `${name}.pem`,
      "-days",
      "30",
      "-extfile",
      `${name}.ext`,
    );
  } else {
    openssl(
      "req",
      "-x509",
      "-key",
      `${name}.key`,
      "-out",
      `${name}.pem`,
      "-days",
      "30",
      "-subj",
      `/CN=${name}`,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    );
  }
}

function leaf(
  name: string,
  issuer: string,
  eku: string,
  days: string,
  san = `DNS:${name}.test,URI:spiffe://example.test/${name}`,
) {
  openssl(
    "req",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.csr`,
    "-subj",
    `/CN=${name}`,
  );
  writeFileSync(
    join(dir, `${name}.ext`),
    `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${eku}\nsubjectAltName=${san}\n`,
  );
  openssl(
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    "-CA",
    `${issuer}.pem`,
    "-CAkey",
    `${issuer}.key`,
    "-CAcreateserial",
    "-out",
    `${name}.pem`,
    "-days",
    days,
    "-extfile",
    `${name}.ext`,
  );
}

function b64(name: string): string {
  return `:${openssl("x509", "-in", `${name}.pem`, "-outform", "DER").toString("base64")}:`;
}
function pem(name: string): string {
  return readFileSync(join(dir, `${name}.pem`), "utf8");
}
function headers(leafName: string, ...chain: string[]): HeaderPair[] {
  const pairs: HeaderPair[] = [["client-cert", b64(leafName)]];
  if (chain.length > 0)
    pairs.push(["client-cert-chain", chain.map(b64).join(", ")]);
  return pairs;
}
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof OriginatingChainError) return err.code;
    throw err;
  }
  return "ok";
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ingress-evidence-"));
  ca("root");
  ca("inter", "root");
  ca("other-root");
  leaf("alice", "inter", "clientAuth", "30");
  leaf("server-only", "inter", "serverAuth", "30");
  leaf("expired", "inter", "clientAuth", "-1");
  leaf("stranger", "other-root", "clientAuth", "30");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("verifyOriginatingChain", () => {
  const now = () => new Date();

  it("accepts a leaf that chains through the forwarded intermediate to the anchor", () => {
    const chain = parseClientCertFields(headers("alice", "inter"));
    const verified = verifyOriginatingChain(chain, pem("root"), now());
    expect(verified.pathLength).toBe(2);
    expect(verified.leafThumbprintSha256).toBe(chain.leafThumbprintSha256);
    expect(verified.selectors).toEqual([
      { kind: "dns_name", value: "alice.test" },
      { kind: "spiffe_id", value: "spiffe://example.test/alice" },
      { kind: "leaf_thumbprint_sha256", value: chain.leafThumbprintSha256 },
    ]);
    expect(verified.notAfter.getTime()).toBeGreaterThan(Date.now());
  });

  it("accepts when the intermediate is itself an anchor and no chain is forwarded", () => {
    const chain = parseClientCertFields(headers("alice"));
    expect(verifyOriginatingChain(chain, pem("inter"), now()).pathLength).toBe(
      1,
    );
  });

  it("refuses a leaf whose issuer is not forwarded and not an anchor", () => {
    expect(
      codeOf(() =>
        verifyOriginatingChain(
          parseClientCertFields(headers("alice")),
          pem("root"),
          now(),
        ),
      ),
    ).toBe("trust_unknown");
  });

  it("refuses a leaf from a different private root, whatever its subject", () => {
    const chain = parseClientCertFields(headers("stranger"));
    expect(
      codeOf(() =>
        verifyOriginatingChain(chain, pem("root") + pem("inter"), now()),
      ),
    ).toBe("trust_unknown");
  });

  it("refuses an expired leaf and a leaf checked before its window", () => {
    expect(
      codeOf(() =>
        verifyOriginatingChain(
          parseClientCertFields(headers("expired", "inter")),
          pem("root"),
          now(),
        ),
      ),
    ).toBe("evidence_expired");
    expect(
      codeOf(() =>
        verifyOriginatingChain(
          parseClientCertFields(headers("alice", "inter")),
          pem("root"),
          new Date(0),
        ),
      ),
    ).toBe("evidence_expired");
  });

  it("refuses a leaf without clientAuth", () => {
    expect(
      codeOf(() =>
        verifyOriginatingChain(
          parseClientCertFields(headers("server-only", "inter")),
          pem("root"),
          now(),
        ),
      ),
    ).toBe("forwarded_evidence_unverified");
  });

  it("refuses an unusable trust bundle instead of trusting nothing silently", () => {
    const chain = parseClientCertFields(headers("alice", "inter"));
    expect(codeOf(() => verifyOriginatingChain(chain, "", now()))).toBe(
      "malformed_configuration",
    );
    expect(
      codeOf(() => verifyOriginatingChain(chain, pem("alice"), now())),
    ).toBe("malformed_configuration");
  });

  it("ignores an unrelated intermediate in the chain rather than trusting it", () => {
    const chain = parseClientCertFields(
      headers("alice", "other-root", "inter"),
    );
    expect(verifyOriginatingChain(chain, pem("root"), now()).pathLength).toBe(
      2,
    );
  });
});
