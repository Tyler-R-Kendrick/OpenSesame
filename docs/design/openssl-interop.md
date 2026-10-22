# OpenSSL interoperability

OpenSSL is a toolkit, not a wire specification. For the PWA, “OpenSSL support”
means reading and writing the formats OpenSSL, Bouncy Castle and cryptlib
commonly exchange: PEM armour, DER, X.509 certificates, PKCS#1/PKCS#8/SEC1
private keys, and the labels around them.

Status: implemented for certificate and private-key inspection in
`@opensesame/vault-core/openssl`.

## Supported

| Material | Read | Write | Notes |
|---|---|---|---|
| X.509 certificate PEM | Yes | Issued locally | CN, issuer CN, SAN DNS/IP, serial, validity, CA flag, key/signature algorithm |
| Certificate chain PEM | Yes, up to 8 | Leaf and CAs separately | First block is leaf; the rest become `caPem` |
| `TRUSTED CERTIFICATE` | Label recognised | No | Trust aux data is not interpreted; the block is not imported as a certificate |
| PKCS#8 `PRIVATE KEY` | Yes | Local issuance | RSA, EC, Ed25519, Ed448, DSA OID |
| `ENCRYPTED PRIVATE KEY` | Detected | No | Never decrypted; no passphrase prompt |
| PKCS#1 `RSA PRIVATE KEY` | Yes | No | RSA modulus size reported |
| SEC1 `EC PRIVATE KEY` | Yes | No | Curve size where named |
| `DSA PRIVATE KEY` | Detected | No | No signing |
| OpenSSL legacy encrypted PEM | Detected | No | `Proc-Type: 4,ENCRYPTED`, `DEK-Info` |
| OpenSSH private key | Detected | SSH editor | OpenSSH armour, not OpenSSL |
| PEM/DER bounds | Yes | — | 1 MiB text, 256 KiB per block, 64 blocks |

The certificate item view fills empty metadata from the PEM itself. A
certificate imported as PEM therefore shows its common name, SANs, expiry and
serial even when those fields were not separately entered. The item parser
also splits a chain into the leaf (`certificatePem`) and the remaining
certificates (`caPem`).

## Not supported in the PWA

- **PKCS#12 / `.p12` / `.pfx`.** A PFX is binary, password-protected and may
  combine a leaf, chain and shrouded key. Parsing it needs a passphrase UI and
  PBES2 decryption; the current browser path does not take a password for a
  key-material import. Use the native CLI or a platform certificate store.
- **PKCS#7/CMS verification or decryption.** The PEM labels `PKCS7` and `CMS`
  are recognised, but no signed/encrypted message is parsed. There is no
  current PWA workflow that consumes one.
- **Encrypted private-key decryption.** Encrypted material is reported as
  encrypted and remains opaque. The vault seals the bytes; it does not guess a
  passphrase.
- **OpenSSL configuration, providers, engines and command semantics.** The PWA
  does not run OpenSSL or load its modules.
- **Path validation and trust decisions.** The inspector reads facts; it does
  not decide whether a chain is trusted, whether a signature verifies, whether
  a name is permitted, or whether a certificate is revoked.

## Bouncy Castle and cryptlib

Both libraries emit and consume the same standard PEM/DER shapes for the
supported rows, so no separate parser is needed for the common case.

- **Bouncy Castle** also produces PKCS#12 and CMS; those are the unsupported
  rows above, not a different PEM dialect. BC's PEM headers (`Proc-Type`,
  `DEK-Info`) are recognised.
- **cryptlib** uses standard X.509 and PKCS containers. Its PKCS#7/PKCS#12
  output is likewise outside this browser path.
- Neither library is embedded in the PWA. A Java or native library in a static
  browser app would add a second crypto stack and a runtime the platform
  cannot sandbox as well as WebCrypto.

A native daemon may use OpenSSL, Bouncy Castle or cryptlib for PFX/CMS work;
the PWA can hand it a file and receive the already-selected certificate and
key. That boundary is not implemented here.

## Security

- The parser is bounded and iterative; it never follows a length, pointer or
  OID outside the supplied bytes.
- It does not execute macros, OpenSSL config, provider code or Bouncy Castle
  extensions.
- It never asks for, stores or logs a passphrase.
- Private keys remain inside the sealed vault item. Inspection returns only
  public facts: algorithm and size.
- The certificate view does not claim a certificate is trusted. Trust is a
  separate decision.

## Acceptance

- An OpenSSL P-256 certificate parses with CN, both DNS SANs, the IP SAN,
  serial, expiry and `CA:FALSE`.
- A chain of two PEM certificates keeps leaf-first order; the second is
  exposed as `caPem`.
- A 1024-bit PKCS#1 RSA key reports `rsa`, 1024 bits and unencrypted.
- A SEC1 P-256 key reports `ec`, 256 bits.
- A legacy encrypted PEM reports `encrypted: true` and never contains a
  decrypted key.
- Malformed base64, trailing DER and a non-PEM value are refused.
- A certificate imported only as PEM still displays its parsed CN, SANs,
  expiry and serial.
