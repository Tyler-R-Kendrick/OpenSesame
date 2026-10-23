import { describe, expect, it } from "vitest";
import { inspectPrivateKeyPem } from "./keys.js";
import { parsePemBlocks, toPem } from "./pem.js";
import { inspectCertificateBundle, inspectCertificateDer } from "./x509.js";

/** A disposable P-256 certificate made by `openssl req -x509`. */
const CERT = `-----BEGIN CERTIFICATE-----
MIIB0zCCAXmgAwIBAgIUOb3aB2p34qA0V7YK5uKtFPzTYL0wCgYIKoZIzj0EAwIw
HzEdMBsGA1UEAwwUb3BlbnNzbC5leGFtcGxlLnRlc3QwHhcNMjYxMDIyMDMyMjEz
WhcNMjcxMDIyMDMyMjEzWjAfMR0wGwYDVQQDDBRvcGVuc3NsLmV4YW1wbGUudGVz
dDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABBtgRS/7WCoTAO0u3K/a0elgkGAf
Oa3nqkHTZSdaz9XxFFbNHWrikvwQTW5/YyCrEl3bRMvExYJNOgNHhB7fMoWjgZIw
gY8wHQYDVR0OBBYEFKju9zUcXFin4yQIPJWYqrIw1QBeMB8GA1UdIwQYMBaAFKju
9zUcXFin4yQIPJWYqrIw1QBeMD8GA1UdEQQ4MDaCFG9wZW5zc2wuZXhhbXBsZS50
ZXN0ghh3d3cub3BlbnNzbC5leGFtcGxlLnRlc3SHBH8AAAEwDAYDVR0TAQH/BAIw
ADAKBggqhkjOPQQDAgNIADBFAiEAkFnTBx9knF9msFG2IDOHnQNozdKYgy8LhLQl
O2NFkOkCIHvR4129TsMirGQxJBuwHQhIARZ6+xRo3NaOfaZ92aRz
-----END CERTIFICATE-----`;

const EC_KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIAC8vHdOMsQ99eQ9eixtmqBgpdov+LJyv28KBhqxlaGeoAoGCCqGSM49
AwEHoUQDQgAEG2BFL/tYKhMA7S7cr9rR6WCQYB85reeqQdNlJ1rP1fEUVs0dauKS
/BBNbn9jIKsSXdtEy8TFgk06A0eEHt8yhQ==
-----END EC PRIVATE KEY-----`;

const RSA_1024 = `-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQDlugPFXJKk4Vl9SWb72WB+XBFpn617yQfUFHg5SJH7lQu0eha3
kLeOkJcoS5/V+1J5CWkhwQU5l7bsuj3Ax7UiRW2yl4dPTKOxGWJsX13Wu674XF0C
bRxfvmaom0JT+aRz9iAqfSfKpeE8AqGfk92kCUowUhuD0uVRK7/FD0sV3wIDAQAB
AoGBAKYhSUzWz23RUcga5xDGeNOofScnRGw6SyEB1JeIdZm8hYR0riz9yOCei9Gm
LuauI0xIk/DHB6JIpw62+KWLRt8tFK8H0mBcq5HJqiWNZ7znBzN5h0BAm4KagOqX
iXQWM97gPyHagZ4QFXI54XpgnRCabchC58ARdvMDMeqIj+yxAkEA9SsveDIbxaF9
uCC+PMYxWY2+Q9EfqkHBLLac/64m2wr5RQimgFO6EVsolQph/cIqJ8yPD1zSyq5o
Slfk9Ek7fQJBAO/gLqPIDvFM269R3g9VmDBLdA+mzuUk582MzMOPiHCKepKCJCUV
Wvi8S3TUlvhoR3zACxr3zVGYGinKwdq3PYsCQE319ZpbFMm7mKa8gsIApCC+Ggqm
rVMOpcb6KuKDFogA7VMudQPJnBl4y2bZbl+rJoyRV8yiz8TzwOYjHQMxZmECQQCg
sv5r6L3h+AyAwobSnRQs3o+tYKHgrz2/3eDb7o+IXa1J83fFhC4Czxp59WYCmtGx
iHKoKXTagdydPOFr5jCLAkBIdRJpbs24Yd461ppo4NKuOVTIWO9IXDTj3+I4wXdq
e3nd7e8ho/TyDUG1oas0X2PI4UTaQYgn6rssUUmbd7GJ
-----END RSA PRIVATE KEY-----`;

describe("OpenSSL PEM and X.509 inspection", () => {
  it("reads an OpenSSL certificate's subject, SANs, serial, expiry and CA flag", () => {
    const bundle = inspectCertificateBundle(CERT);
    expect(bundle).not.toBeNull();
    const leaf = bundle?.certificates[0];
    expect(leaf).toMatchObject({
      subjectCommonName: "openssl.example.test",
      issuerCommonName: "openssl.example.test",
      dnsNames: ["openssl.example.test", "www.openssl.example.test"],
      ipAddrs: ["127.0.0.1"],
      keyAlgorithm: "ec",
      isCa: false,
    });
    expect(leaf?.serial).toMatch(/^[0-9A-F]+$/u);
    expect(leaf?.notAfter).toMatch(/^2027-10-22T/u);
    expect(leaf?.signatureAlgorithm).toBe("1.2.840.10045.4.3.2");
  });

  it("keeps a chain in order and re-armours each certificate", () => {
    const bundle = inspectCertificateBundle(`${CERT}\n${CERT}`);
    expect(bundle?.certificates).toHaveLength(2);
    expect(bundle?.pem).toHaveLength(2);
    expect(bundle?.pem[0]).toContain("BEGIN CERTIFICATE");
  });

  it("refuses malformed armour and trailing DER", () => {
    expect(
      inspectCertificateBundle(
        "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
      ),
    ).toBeNull();
    const der = parsePemBlocks(CERT)[0]?.der;
    if (der === undefined) throw new Error("fixture did not parse");
    expect(inspectCertificateDer(new Uint8Array([...der, 0]))).toBeNull();
  });

  it("reads PKCS#1 and SEC1 private keys, including key size", () => {
    expect(inspectPrivateKeyPem(RSA_1024)).toMatchObject({
      algorithm: "rsa",
      bits: 1024,
      encrypted: false,
    });
    expect(inspectPrivateKeyPem(EC_KEY)).toMatchObject({
      algorithm: "ec",
      bits: 256,
      encrypted: false,
    });
  });

  it("recognises encrypted PKCS#8 without decrypting it", () => {
    const encrypted = `-----BEGIN ENCRYPTED PRIVATE KEY-----
MIH0MF8GCSqGSIb3DQEFDTBSMDEGCSqGSIb3DQEFDDAkBBDtvOyeUg/s8hhFSPsJ
5Y0wAgIIADAMBggqhkiG9w0CCQUAMB0GCWCGSAFlAwQBKgQQ8GC4g35KO4A/nOpU
Tryk6gSBkOiHkPWNYljQH23m2K7h5sZX/BLJF9BJg3NXM0I+Lc+pim41TXzH84V/
qrTxKrSRAaf4xr5OjUr1kCuH+MBadozgIQ8niDXKfApHXavZxxokjSVyKLPyOsm3
RynLON8c3v0NR3Q/IVYbrV1z+XK7gqeZiGS6zAjfgo9Mz4KDCmBTUQGwMNHIwTcR
w7vvjYYwvQ==
-----END ENCRYPTED PRIVATE KEY-----`;
    expect(inspectPrivateKeyPem(encrypted)).toMatchObject({
      encrypted: true,
      bits: null,
      algorithm: "unknown",
    });
  });

  it("recognises legacy OpenSSL encryption without decrypting it", () => {
    const encrypted = `-----BEGIN RSA PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
DEK-Info: AES-256-CBC,00000000000000000000000000000000

MIIB
-----END RSA PRIVATE KEY-----`;
    expect(inspectPrivateKeyPem(encrypted)).toMatchObject({
      algorithm: "rsa",
      encrypted: true,
      bits: null,
    });
  });

  it("round-trips one PEM block and rejects non-PEM input", () => {
    const decoded = parsePemBlocks(CERT)[0];
    if (decoded === undefined) throw new Error("fixture did not parse");
    expect(parsePemBlocks(toPem(decoded.der, "CERTIFICATE"))[0]?.der).toEqual(
      decoded.der,
    );
    expect(parsePemBlocks("not a PEM file")).toEqual([]);
  });
});
