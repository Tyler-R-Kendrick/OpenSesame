/**
 * Local certificate issuance produces a real X.509 v3 certificate: these
 * tests parse the output with Node's own X.509 implementation (OpenSSL
 * underneath), and with the `openssl` binary when it is installed.
 */
import { spawnSync } from "node:child_process";
import {
  X509Certificate,
  createPrivateKey,
  createSign,
  createVerify,
} from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type IssuedCertificate,
  acknowledgeCertificateDelivery,
  certsSeams,
  issueCertificate,
} from "./certs.js";

const HOUR_MS = 60 * 60 * 1000;

async function issueSample(): Promise<{
  issued: IssuedCertificate;
  cert: X509Certificate;
  before: number;
  after: number;
}> {
  const before = Date.now();
  const issued = await issueCertificate({
    commonName: "barber.local",
    dnsNames: ["barber.local", "www.barber.local"],
    ipAddrs: ["127.0.0.1", "::1", "2001:db8::8a2e:370:7334"],
    ttlHours: 48,
  });
  const after = Date.now();
  return {
    issued,
    cert: new X509Certificate(issued.certificate),
    before,
    after,
  };
}

describe("issueCertificate", () => {
  it("issues a certificate that parses and verifies under its own key", async () => {
    const { cert } = await issueSample();
    expect(cert.verify(cert.publicKey)).toBe(true);
    // Self-signed, yet not an issuer: without keyCertSign it can sign no
    // other certificate, itself included, as far as a verifier cares.
    expect(cert.checkIssued(cert)).toBe(false);
  });

  it("names the common name as both subject and issuer", async () => {
    const { cert } = await issueSample();
    expect(cert.subject).toBe("CN=barber.local");
    expect(cert.issuer).toBe("CN=barber.local");
  });

  it("lists every DNS name and IP address in subjectAltName", async () => {
    const { cert } = await issueSample();
    expect(cert.subjectAltName).toBe(
      "DNS:barber.local, DNS:www.barber.local, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1, IP Address:2001:DB8:0:0:0:8A2E:370:7334",
    );
    expect(cert.checkHost("www.barber.local")).toBe("www.barber.local");
    expect(cert.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(cert.checkIP("::1")).toBe("::1");
  });

  it("is valid from issuance for exactly the requested lifetime", async () => {
    const { issued, cert, before, after } = await issueSample();
    const from = Date.parse(cert.validFrom);
    const to = Date.parse(cert.validTo);
    expect(from).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(from).toBeLessThanOrEqual(after);
    expect(to - from).toBe(48 * HOUR_MS);
    expect(Date.parse(issued.notBefore)).toBe(from);
    expect(Date.parse(issued.notAfter)).toBe(to);
  });

  it("reports a positive serial of at least 64 bits that matches the certificate", async () => {
    const { issued, cert } = await issueSample();
    expect(issued.serial).toBe(cert.serialNumber);
    expect(issued.serial).toMatch(/^[0-9A-F]+$/);
    const serial = BigInt(`0x${issued.serial}`);
    expect(serial > 0n).toBe(true);
    expect(serial >= 1n << 64n).toBe(true);
    expect(issued.serial.length).toBeLessThanOrEqual(40);
  });

  it("draws a fresh serial and key for every issuance", async () => {
    const [one, two] = await Promise.all([issueSample(), issueSample()]);
    expect(one.issued.serial).not.toBe(two.issued.serial);
    expect(one.cert.publicKey.equals(two.cert.publicKey)).toBe(false);
  });

  it("is an end-entity certificate for TLS server and client authentication", async () => {
    const { cert } = await issueSample();
    expect(cert.ca).toBe(false);
    expect(cert.keyUsage).toEqual(
      expect.arrayContaining(["1.3.6.1.5.5.7.3.1", "1.3.6.1.5.5.7.3.2"]),
    );
    const text = cert.toLegacyObject();
    expect(text.ext_key_usage).toEqual([
      "1.3.6.1.5.5.7.3.1",
      "1.3.6.1.5.5.7.3.2",
    ]);
  });

  it("carries an ECDSA P-256 key", async () => {
    const { cert } = await issueSample();
    expect(cert.publicKey.asymmetricKeyType).toBe("ec");
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
  });

  it("hands back a PKCS#8 private key that signs for the certificate's key", async () => {
    const { issued, cert } = await issueSample();
    expect(issued.privateKey).toMatch(
      /^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END PRIVATE KEY-----\n$/,
    );
    const key = createPrivateKey(issued.privateKey);
    expect(key.asymmetricKeyType).toBe("ec");
    const message = Buffer.from("proof of possession");
    const signature = createSign("sha256").update(message).sign(key);
    expect(
      createVerify("sha256").update(message).verify(cert.publicKey, signature),
    ).toBe(true);
  });

  it("returns the record fields the item editor saves", async () => {
    const { issued } = await issueSample();
    expect(issued.certificate).toMatch(
      /^-----BEGIN CERTIFICATE-----\n([A-Za-z0-9+/=]{1,64}\n)+-----END CERTIFICATE-----\n$/,
    );
    expect(issued.commonName).toBe("barber.local");
    expect(issued.dnsNames).toEqual(["barber.local", "www.barber.local"]);
    expect(issued.caCertificate).toBe("");
    expect(issued.deliveryId).toBe(`local-barber.local-${issued.serial}`);
    await expect(
      acknowledgeCertificateDelivery(issued.deliveryId ?? ""),
    ).resolves.toBeUndefined();
  });

  it("defaults to a 24-hour lifetime and no alternative names", async () => {
    const issued = await issueCertificate({ commonName: "  localhost  " });
    const cert = new X509Certificate(issued.certificate);
    expect(cert.subject).toBe("CN=localhost");
    expect(cert.subjectAltName).toBeUndefined();
    expect(Date.parse(cert.validTo) - Date.parse(cert.validFrom)).toBe(
      24 * HOUR_MS,
    );
    expect(cert.verify(cert.publicKey)).toBe(true);
  });

  it("switches notAfter to GeneralizedTime past 2049 and still parses", async () => {
    const issued = await issueCertificate({
      commonName: "long.local",
      ttlHours: 24 * 365 * 40,
    });
    const cert = new X509Certificate(issued.certificate);
    expect(new Date(cert.validTo).getUTCFullYear()).toBeGreaterThanOrEqual(
      2050,
    );
    expect(Date.parse(cert.validTo)).toBe(Date.parse(issued.notAfter));
    expect(cert.verify(cert.publicKey)).toBe(true);
  });

  it("encodes a common name outside ASCII as UTF-8", async () => {
    const issued = await issueCertificate({ commonName: "café.local" });
    expect(new X509Certificate(issued.certificate).subject).toBe(
      "CN=café.local",
    );
  });

  it("routes the exported functions through the seam", async () => {
    const original = { ...certsSeams };
    const fake: IssuedCertificate = {
      certificate: "c",
      privateKey: "k",
      caCertificate: "",
      serial: "01",
      commonName: "x",
      dnsNames: [],
      notBefore: "",
      notAfter: "",
    };
    certsSeams.issueCertificate = async () => fake;
    try {
      await expect(issueCertificate({ commonName: "x" })).resolves.toBe(fake);
    } finally {
      Object.assign(certsSeams, original);
    }
  });
});

describe("issueCertificate input validation", () => {
  it.each([
    [{ commonName: "" }, /common name/i],
    [{ commonName: "   " }, /common name/i],
    [{ commonName: "x".repeat(65) }, /common name/i],
    [{ commonName: "a\u0000b" }, /common name/i],
    [{ commonName: "ok", dnsNames: ["bad_name.local"] }, /bad_name\.local/],
    [{ commonName: "ok", dnsNames: ["-lead.local"] }, /DNS name/],
    [{ commonName: "ok", dnsNames: ["a..b"] }, /DNS name/],
    [{ commonName: "ok", dnsNames: [`${"a".repeat(64)}.local`] }, /DNS name/],
    [{ commonName: "ok", dnsNames: ["10.0.0.1"] }, /DNS name/],
    [{ commonName: "ok", dnsNames: ["a.*.local"] }, /DNS name/],
    [{ commonName: "ok", dnsNames: ["bücher.local"] }, /DNS name/],
    [{ commonName: "ok", ipAddrs: ["256.0.0.1"] }, /256\.0\.0\.1/],
    [{ commonName: "ok", ipAddrs: ["1.2.3"] }, /IP address/],
    [{ commonName: "ok", ipAddrs: ["01.2.3.4"] }, /IP address/],
    [{ commonName: "ok", ipAddrs: ["1::2::3"] }, /IP address/],
    [{ commonName: "ok", ipAddrs: ["1:2:3:4:5:6:7:8:9"] }, /IP address/],
    [{ commonName: "ok", ipAddrs: ["fe80::1%eth0"] }, /IP address/],
    [{ commonName: "ok", ipAddrs: ["localhost"] }, /IP address/],
    [{ commonName: "ok", ttlHours: 0 }, /lifetime/i],
    [{ commonName: "ok", ttlHours: -1 }, /lifetime/i],
    [{ commonName: "ok", ttlHours: Number.NaN }, /lifetime/i],
    [{ commonName: "ok", ttlHours: Number.POSITIVE_INFINITY }, /lifetime/i],
    [{ commonName: "ok", ttlHours: 24 * 366 * 10_000 }, /lifetime/i],
  ])("rejects %j", async (input, message) => {
    await expect(issueCertificate(input)).rejects.toThrow(message);
  });

  it("accepts a wildcard leftmost label and IPv4-mapped IPv6", async () => {
    const issued = await issueCertificate({
      commonName: "wild",
      dnsNames: ["*.dev.local"],
      ipAddrs: ["::ffff:192.168.1.10"],
    });
    const cert = new X509Certificate(issued.certificate);
    expect(cert.subjectAltName).toBe(
      "DNS:*.dev.local, IP Address:0:0:0:0:0:FFFF:C0A8:10A",
    );
  });
});

const openssl = spawnSync("openssl", ["version"], { encoding: "utf8" });
const hasOpenssl = openssl.status === 0;

describe.skipIf(!hasOpenssl)("openssl x509 reads the certificate", () => {
  it("prints the v3 fields and extensions", async () => {
    const { issued } = await issueSample();
    const result = spawnSync("openssl", ["x509", "-noout", "-text"], {
      input: issued.certificate,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const text = result.stdout;
    expect(text).toContain("Version: 3 (0x2)");
    expect(text).toContain("Signature Algorithm: ecdsa-with-SHA256");
    expect(text).toContain("Subject: CN = barber.local");
    expect(text).toContain("Issuer: CN = barber.local");
    expect(text).toContain("ASN1 OID: prime256v1");
    expect(text).toMatch(/X509v3 Basic Constraints: critical\s+CA:FALSE/);
    expect(text).toMatch(/X509v3 Key Usage: critical\s+Digital Signature/);
    expect(text).toMatch(
      /X509v3 Extended Key Usage:\s+TLS Web Server Authentication, TLS Web Client Authentication/,
    );
    expect(text).toMatch(
      /X509v3 Subject Alternative Name:\s+DNS:barber\.local, DNS:www\.barber\.local, IP Address:127\.0\.0\.1, IP Address:0:0:0:0:0:0:0:1,/,
    );
    expect(text).toContain("X509v3 Subject Key Identifier:");

    const dir = mkdtempSync(join(tmpdir(), "os-cert-"));
    try {
      const file = join(dir, "leaf.pem");
      writeFileSync(file, issued.certificate);
      // A self-signed end-entity certificate verifies as its own anchor.
      const verify = spawnSync(
        "openssl",
        [
          "verify",
          "-CAfile",
          file,
          "-partial_chain",
          "-purpose",
          "sslserver",
          file,
        ],
        { encoding: "utf8" },
      );
      expect(verify.stdout.trim(), verify.stderr).toBe(`${file}: OK`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
