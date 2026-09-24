/**
 * SEC-IDENTITIES / SEC-REVIEW for the Identity plane's evidence producer.
 *
 * Two properties are under test, both of which the Rust plane enforces and
 * which this mirror must not weaken:
 *
 *  1. Verified evidence has no public construction. `attestPeer` is the only
 *     door: a request body, a header, a plugin manifest — or a module that
 *     simply imports the class — must not be able to hand the admission path
 *     a `VerifiedPeer` it did not verify (AT-TLS-FAKECONTEXT).
 *  2. Selector extraction is exactly as strict as `@opensesame/os-domain`'s
 *     decoder, which is the canonical mirror of the Rust validator. Anything
 *     `selectorsOf` emits must survive `decodeSelector`, or the two planes
 *     disagree about what a certificate says — which is where identity
 *     confusion lives.
 */
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSelector, selectorEntry } from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VerifiedPeer, attestPeer, selectorsOf } from "../peer-evidence.js";

/**
 * A self-signed leaf carrying exactly the SAN text a test names. Self-signed
 * is the point: this is material an attacker can make, and none of it is
 * trusted by anything — it is only ever fed to the extractor.
 */
function hostileLeaf(dir: string, name: string, sans: string[]): string {
  const key = join(dir, `${name}.key`);
  const cert = join(dir, `${name}.crt`);
  const run = (args: string[]) =>
    execFileSync("openssl", args, {
      cwd: dir,
      stdio: ["ignore", "ignore", "pipe"],
    });
  run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key]);
  run([
    "req",
    "-x509",
    "-new",
    "-key",
    key,
    "-days",
    "2",
    "-subj",
    "/CN=hostile-leaf",
    "-addext",
    "basicConstraints=critical,CA:FALSE",
    "-addext",
    "keyUsage=critical,digitalSignature",
    "-addext",
    "extendedKeyUsage=clientAuth",
    "-addext",
    `subjectAltName=${sans.join(",")}`,
    "-out",
    cert,
  ]);
  return readFileSync(cert, "utf8");
}

describe("peer evidence: selector extraction is not lenient", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "os-peer-sec-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * Everything a hostile certificate can carry, in one leaf: an address, an
   * address dressed as a URI, a literal address, a wildcard, an uppercase
   * name, a percent-encoded SPIFFE path, a second SPIFFE ID, and a URI with
   * a fragment. The canonical decoder is the oracle.
   */
  it("emits only selectors the canonical decoder accepts", () => {
    const pem = hostileLeaf(dir, "hostile", [
      "email:admin@corp.example",
      "URI:mailto:admin@corp.example",
      "IP:10.0.0.7",
      "DNS:*.internal",
      "DNS:BRIDGE.Internal",
      "URI:spiffe://prod.example/bridge%2fadmin",
      "URI:spiffe://prod.example/bridge",
      "URI:https://prod.example/admin#root",
    ]);
    const selectors = selectorsOf(new X509Certificate(pem));
    for (const selector of selectors) {
      const [kind, value] = selectorEntry(selector);
      const decoded = decodeSelector("peer", { [kind]: value });
      expect(
        decoded.ok,
        `selectorsOf emitted ${kind}=${value}, which the canonical decoder refuses`,
      ).toBe(true);
    }
  });

  it("never lowers an address or a literal into a name", () => {
    const pem = hostileLeaf(dir, "address", [
      "email:admin@corp.example",
      "URI:mailto:admin@corp.example",
      "IP:10.0.0.7",
    ]);
    const values = selectorsOf(new X509Certificate(pem)).map(
      (s) => selectorEntry(s)[1],
    );
    expect(values.some((v) => v.includes("@"))).toBe(false);
    expect(values).not.toContain("10.0.0.7");
  });

  it("derives no SPIFFE identity from two SPIFFE SANs", () => {
    const pem = hostileLeaf(dir, "twospiffe", [
      "URI:spiffe://prod.example/bridge",
      "URI:spiffe://prod.example/admin",
    ]);
    const kinds = selectorsOf(new X509Certificate(pem)).map(
      (s) => selectorEntry(s)[0],
    );
    expect(kinds.filter((k) => k === "spiffe_id")).toHaveLength(0);
  });
});

describe("peer evidence: verified evidence has no public construction", () => {
  let dir: string;
  let leaf: X509Certificate;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "os-peer-ctor-"));
    leaf = new X509Certificate(
      hostileLeaf(dir, "attacker", ["DNS:bridge.internal"]),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const attested = () =>
    ({
      source: "direct_tls",
      leaf,
      trustProfile: { name: "clients" },
      trustGeneration: 1,
      credentialGeneration: 1,
      listener: "identity-tls",
      policy: "mtls_required",
      tlsVersion: "tls13",
      authenticatedAt: new Date(),
      usableForMs: 60_000,
    }) as const;

  it("refuses to attest a certificate outside its validity window", () => {
    expect(() =>
      attestPeer({
        ...attested(),
        authenticatedAt: new Date(leaf.validToDate.getTime() + 1000),
      }),
    ).toThrow(/validity window/);
  });

  /**
   * The class is exported for its type and its getters. Calling it as a
   * constructor must not produce evidence: that path skips the window check
   * and takes the thumbprint as an argument instead of computing it, so a
   * caller could otherwise mint a peer whose digest is not its certificate's.
   */
  it("cannot be built by calling the exported class", () => {
    const Ctor = VerifiedPeer as unknown as new (
      ...args: unknown[]
    ) => VerifiedPeer;
    expect(
      () =>
        new Ctor(
          { ...attested(), authenticatedAt: new Date(0) },
          "0".repeat(64),
          new Date(Date.now() + 86_400_000),
        ),
    ).toThrow();
  });

  it("cannot be revived from its own serialized view", () => {
    const peer = attestPeer(attested());
    const view = JSON.parse(JSON.stringify(peer)) as Record<string, unknown>;
    expect(view.leaf_thumbprint_sha256).toBe(peer.leafThumbprintSha256());
    // The view is a DTO. Nothing in the module turns one back into evidence.
    expect(Object.keys(view)).not.toContain("leaf");
    expect(
      (attestPeer as unknown as Record<string, unknown>).fromJSON,
    ).toBeUndefined();
  });
});
