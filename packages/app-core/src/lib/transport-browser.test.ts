import { afterEach, describe, expect, it } from "vitest";
import {
  PublicPemError,
  exportPublicCertificatePem,
  heldBrowserCertificate,
  holdBrowserCertificate,
  importPublicCertificatePem,
} from "./transport-browser.js";

/**
 * A disposable self-signed public certificate minted with openssl for this
 * test (CN=transport-fixture.invalid, two days, P-256). Its private key was
 * deleted at mint time. The thumbprint below is openssl's own reading:
 *   openssl x509 -in cert.pem -outform DER | sha256sum
 */
const PUBLIC_CERT = `-----BEGIN CERTIFICATE-----
MIIBnDCCAUOgAwIBAgIUIX2fAHaYc8wVOdMoHd2O8ER9y5IwCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZdHJhbnNwb3J0LWZpeHR1cmUuaW52YWxpZDAeFw0yNjA5MjIw
MDI1MTlaFw0yNjA5MjQwMDI1MTlaMCQxIjAgBgNVBAMMGXRyYW5zcG9ydC1maXh0
dXJlLmludmFsaWQwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARoM0J/ezhWeetd
e6Vel4pt58zeS4AmL7S532e1rKNZpOyxmKOxQdRmLcu4vqJ4ebyB7w7xJEEEI8FF
THYTolRho1MwUTAdBgNVHQ4EFgQUYrXL6dzaIDEl9rwzpPIAPB4TxcEwHwYDVR0j
BBgwFoAUYrXL6dzaIDEl9rwzpPIAPB4TxcEwDwYDVR0TAQH/BAUwAwEB/zAKBggq
hkjOPQQDAgNHADBEAiBwRIbV6sqH0+q1iyL22nJYVe7/XcfjjYbaFMnkaO494AIg
OpRrh8+p4n4UljqtondAcgRh/cR1CYfEBOIQOn8mbw4=
-----END CERTIFICATE-----
`;
const OPENSSL_THUMBPRINT =
  "79269580d4743cecd7a729fb8b9a8c62079ec5e3ba466ea75ffd0dbca439ff85";

afterEach(() => holdBrowserCertificate(null));

describe("importPublicCertificatePem", () => {
  it("computes the leaf thumbprint openssl computes", async () => {
    const material = await importPublicCertificatePem(PUBLIC_CERT, () => 0);
    expect(material.thumbprint).toBe(OPENSSL_THUMBPRINT);
    expect(material.chainLength).toBe(1);
    expect(material.pem).toBe(PUBLIC_CERT);
    expect(material.importedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("refuses a file that carries any private material, whole", async () => {
    const combined = `${PUBLIC_CERT}-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\n-----END EC PRIVATE KEY-----\n`;
    await expect(importPublicCertificatePem(combined)).rejects.toMatchObject({
      reason: "private_material",
    });
    await expect(
      importPublicCertificatePem(`${PUBLIC_CERT}-----BEGIN PRIVATE KEY-----`),
    ).rejects.toBeInstanceOf(PublicPemError);
    expect(heldBrowserCertificate()).toBeNull();
  });

  it("refuses text with no certificate, a bogus block, and an oversize file", async () => {
    await expect(importPublicCertificatePem("hello")).rejects.toMatchObject({
      reason: "no_certificate",
    });
    await expect(
      importPublicCertificatePem(
        "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----",
      ),
    ).rejects.toMatchObject({ reason: "malformed" });
    await expect(
      importPublicCertificatePem("x".repeat(70_000)),
    ).rejects.toMatchObject({ reason: "too_large" });
  });

  it("exports exactly the public PEM, named by thumbprint", async () => {
    const material = await importPublicCertificatePem(
      `junk before\n${PUBLIC_CERT}junk after`,
    );
    const { filename, blob } = exportPublicCertificatePem(material);
    expect(filename).toBe(
      `browser-certificate-${OPENSSL_THUMBPRINT.slice(0, 12)}.pem`,
    );
    expect(await blob.text()).toBe(PUBLIC_CERT);
  });
});
