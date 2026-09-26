# Audit 2026-09-26 — Local certificate issuance

Scope: `packages/app-core/src/lib/certs.ts`. The Pages item editor calls it
when a person presses *Create certificate* (a `vault.certificate-records`
record), and `certs.issue` maps onto that same walkthrough.

## Findings

1. **High — the "certificate" was not a certificate.** The module said it
   issued a self-signed X.509 certificate with WebCrypto. In fact
   `buildSelfSignedCertPem` joined fixed base64 fragments and spliced in the
   common name, a hex serial and a hex expiry, with the stray word "serif"
   in the middle. The result was not DER. OpenSSL rejects it
   (`PEM routines::bad end line`), and so do Node, browsers and TLS
   servers. Its doc comment still said "For production use".
   **Impact:** anyone who exported the record got material that no TLS stack
   would load, while the vault showed a certificate "PEM on this device". A
   feature that claims to be security material and silently is not gets
   worked around, often with something weaker.

2. **Medium — the key could not sign.** The key pair was RSA-OAEP with
   usages `encrypt`/`decrypt`. The private key handed to the person could not
   make a TLS `CertificateVerify` or any other signature under WebCrypto.
   So even a correctly encoded certificate over it would have been useless
   for its stated purpose.

3. **Medium — a weak, predictable serial.** The serial was
   `Math.random() * 0xffffffff`: 32 bits from a non-cryptographic PRNG.
   RFC 5280 §4.1.2.2 and CA/Browser Forum practice call for at least 64
   bits of CSPRNG output in a positive INTEGER of at most 20 octets. Serial
   entropy is what stops a chosen-prefix collision from being aimed at a
   predictable to-be-signed certificate.

4. **Low — no input validation.** Any common name, DNS name, IP string and
   lifetime was accepted. A `ttlHours` of `0` silently became 24, because
   `ttlHours || 24` was used, and a negative lifetime produced an expiry in
   the past.

5. **Low — the test seam was bypassed.** `certsSeams` held the exported
   functions themselves. Replacing a seam therefore never changed what
   `ItemEditor` imported, and four editor tests for certificate issuance
   were `it.skip`ped instead of fixed.

## Fix

`issueCertificate` now makes a real self-signed X.509 v3 end-entity
certificate with no new dependency. The Pages gzip budget had about 10 KiB
of headroom, and the whole change costs about 2 KiB gzip.

- **Key:** ECDSA P-256 from `crypto.subtle.generateKey`, usages
  `sign`/`verify`, exported as PKCS#8 PEM for the vault to seal.
- **Signature:** ecdsa-with-SHA256 over the DER TBSCertificate.
  WebCrypto's raw `r‖s` is converted to a DER `Ecdsa-Sig-Value`.
- **Serial:** 16 bytes from `crypto.getRandomValues`. The top bit is
  cleared and the first byte forced nonzero, so the INTEGER is positive,
  minimal, 16 octets long and carries at least 121 random bits. `serial` in
  the record is that serial in upper-case hex.
- **Names:**
  - Issuer and subject are both `CN=<common name>`, as a UTF8String.
  - subjectAltName carries the dNSName entries and the iPAddress entries
    (4 or 16 octets).
- **Validity:** UTCTime through 2049 and GeneralizedTime from 2050 on,
  whole seconds. The record's `notBefore` and `notAfter` state exactly what
  the certificate says.
- **Extensions:**
  - basicConstraints `CA:FALSE`, critical;
  - keyUsage `digitalSignature`, critical;
  - extKeyUsage `serverAuth` and `clientAuth`;
  - subjectAltName, when names are given;
  - subjectKeyIdentifier (RFC 7093 §2 method 1).
- **Validation:** the request is refused with a message the editor shows
  for any of these:
  - an empty common name, one over 64 characters, or one with control
    characters;
  - a DNS name that is not an ASCII hostname (a wildcard is allowed only as
    the whole leftmost label, and a numeric final label is refused);
  - an IP that is not a strict dotted quad or RFC 4291 IPv6 text (zones and
    brackets are refused);
  - a lifetime that is not positive and finite, or that ends after
    9999-12-31.
- **`caCertificate`** stays empty. A self-signed certificate has no issuing
  CA, and showing the leaf as its own CA would misstate what it is.
- **Seam:** the exported functions call through `certsSeams`, so the four
  skipped editor tests run again.

The DER encoder lives in `packages/app-core/src/lib/x509/` (`der.ts`,
`names.ts`, `certificate.ts`). It reads nothing and parses nothing, so it
has no decoder attack surface. It uses only `crypto` and `btoa`, which are
in the app-core runtime contract. The bare-isolate sandbox's `crypto.subtle`
has no ECDSA, so issuance there fails with `NotSupportedError` rather than
producing anything weaker.

What this is **not**: a CA-issued certificate. Nothing trusts it until a
person installs it as a trust anchor, and it chains to nothing.

## Regression tests

- `packages/app-core/src/lib/certs.test.ts` parses every issued
  certificate with Node's `crypto.X509Certificate` and checks:
  - it verifies under its own public key;
  - subject and issuer are the CN, and a UTF-8 CN round-trips;
  - subjectAltName lists the DNS and IP entries, including IPv6 and
    IPv4-mapped IPv6;
  - validity matches the lifetime to the second, with GeneralizedTime past
    2049;
  - the serial matches the record, is ≥ 64 bits, and differs per issuance;
  - `ca` is false, and serverAuth and clientAuth are present;
  - the key is EC P-256;
  - the PKCS#8 PEM loads with `createPrivateKey`, and a signature made with
    it verifies under the certificate's key;
  - bad inputs are refused, with 23 rejection cases.

  When `openssl` is on PATH, the same file runs `openssl x509 -noout -text`
  and checks the version, the algorithm, the names, every extension and
  its criticality. It also runs
  `openssl verify -partial_chain -purpose sslserver`. The test is skipped
  only when openssl is absent.
- `packages/app-core/src/lib/x509/der.test.ts`:
  - short, `0x81` and `0x82` length forms;
  - minimal INTEGERs, with the leading `0x00` for a set top bit;
  - OID base-128 encoding;
  - UTCTime and GeneralizedTime at the 1950 and 2050 boundaries;
  - trimming of named bit lists;
  - PEM wrapping.
- `packages/app-core/src/lib/x509/names.test.ts` covers DNS name, IPv4 and
  IPv6 acceptance and rejection.
- `packages/app-core/src/lib/x509/certificate.test.ts` covers the `r‖s` to
  DER conversion (padding and trimming), the serial being positive, minimal
  and not repeating, and hex formatting.
- `apps/pages/src/sections/vault/ItemEditor.test.tsx`: four certificate
  tests un-skipped (issue and seal, no save on an issuance failure, retry
  without re-issuing, issue a blank legacy record).

Against the old implementation all 38 tests then in `certs.test.ts` failed.
They included `PEM routines::bad end line` from every parse and 22 bad
inputs that were accepted.

```bash
pnpm --filter @opensesame/app-core exec vitest run src/lib/certs.test.ts src/lib/x509
```
