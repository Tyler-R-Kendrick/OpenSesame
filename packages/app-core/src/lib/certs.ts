/**
 * Local, self-signed certificate issuance with WebCrypto.
 *
 * `issueCertificate` makes a real X.509 v3 certificate on this device: a
 * fresh ECDSA P-256 key, a 16-byte CSPRNG serial, the common name as both
 * subject and issuer, the requested DNS names and IP addresses as
 * subjectAltName, and an end-entity profile (CA:FALSE, digitalSignature,
 * serverAuth + clientAuth), signed ecdsa-with-SHA256 by its own key. It is
 * for local development and device-to-device TLS: no certificate authority
 * issued it, nothing trusts it until a person chooses to, and it chains to
 * nothing. The private key is returned as PKCS#8 PEM for the caller to seal
 * in the vault; no network is involved.
 *
 * Because the certificate is self-signed there is no issuing CA, so
 * `caCertificate` is always empty rather than a copy of the leaf presented
 * as a CA — the record's "Issuing CA" stays blank, which is the truth.
 */
/** A certificate freshly issued on this device. */
export type IssuedCertificate = {
  /** The self-signed certificate, PEM. */
  certificate: string;
  /** Its ECDSA P-256 private key, PKCS#8 PEM. */
  privateKey: string;
  /** Always empty: a self-signed certificate has no issuing CA. */
  caCertificate: string;
  /** The certificate's serial number, upper-case hex. */
  serial: string;
  commonName: string;
  dnsNames: string[];
  notBefore: string;
  notAfter: string;
  deliveryId?: string;
};

export type CertificateRequest = {
  commonName: string;
  dnsNames?: string[];
  ipAddrs?: string[];
  ttlHours?: number;
  idempotencyKey?: string;
};

/**
 * Acknowledge delivery of a locally issued certificate. Local issuance has
 * nobody to acknowledge to — the material is already in the caller's hands —
 * so this resolves immediately; it keeps the issue-then-acknowledge shape a
 * Host-issued certificate would need.
 */
async function acknowledgeLocalDelivery(_deliveryId: string): Promise<void> {}

async function issuanceUnavailable(
  _request: CertificateRequest,
): Promise<IssuedCertificate> {
  throw new Error("Certificate issuance is not installed.");
}

/** Replaceable in tests; the exported functions always call through it. */
export const certsSeams = {
  issueCertificate: issuanceUnavailable,
  acknowledgeCertificateDelivery: acknowledgeLocalDelivery,
};

/** `vault.certificate-records` installs the real issuer while it is on. */
export function installCertificateIssuance(
  issue: (request: CertificateRequest) => Promise<IssuedCertificate>,
): void {
  certsSeams.issueCertificate = issue;
}

/**
 * Issue a self-signed certificate on this device (see the module comment).
 * Rejects with a readable message for an empty or over-long common name, an
 * invalid DNS name or IP address, or a lifetime that is not positive.
 * `idempotencyKey` is accepted for callers that retry; local issuance keeps
 * no ledger, and the caller holds on to the result instead.
 */
export function issueCertificate(
  request: CertificateRequest,
): Promise<IssuedCertificate> {
  return certsSeams.issueCertificate(request);
}

/** See `acknowledgeLocalDelivery`. */
export function acknowledgeCertificateDelivery(
  deliveryId: string,
): Promise<void> {
  return certsSeams.acknowledgeCertificateDelivery(deliveryId);
}
