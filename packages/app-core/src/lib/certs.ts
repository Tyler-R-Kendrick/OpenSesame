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
import {
  randomSerial,
  signSelfSignedCertificate,
  toHex,
} from "./x509/certificate.js";
import { toPem } from "./x509/der.js";
import { isDnsName, parseIpAddress } from "./x509/names.js";

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

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_TTL_HOURS = 24;
/** RFC 5280 ub-common-name. */
const MAX_COMMON_NAME = 64;
/** GeneralizedTime has four year digits. */
const LAST_EXPRESSIBLE_MS = Date.UTC(9999, 11, 31, 23, 59, 59);

/** Trimmed, non-empty, first occurrence of each. */
function tidy(values: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function checkCommonName(raw: string): string {
  const commonName = raw.trim();
  if (commonName.length === 0) {
    throw new Error("Enter a common name for the certificate.");
  }
  if ([...commonName].length > MAX_COMMON_NAME) {
    throw new Error(
      `A certificate's common name can be at most ${MAX_COMMON_NAME} characters.`,
    );
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
  if (/[\u0000-\u001f\u007f]/.test(commonName)) {
    throw new Error(
      "A certificate's common name cannot hold control characters.",
    );
  }
  return commonName;
}

function checkLifetime(ttlHours: number, from: number): number {
  const until = from + ttlHours * HOUR_MS;
  if (
    !Number.isFinite(ttlHours) ||
    ttlHours <= 0 ||
    !Number.isFinite(until) ||
    until > LAST_EXPRESSIBLE_MS
  ) {
    throw new Error(
      "Choose a certificate lifetime of more than zero hours that ends before the year 10000.",
    );
  }
  return Math.floor(until / 1000) * 1000;
}

/** Validate a request and make its self-signed certificate. */
async function issueSelfSignedCertificate(
  request: CertificateRequest,
): Promise<IssuedCertificate> {
  const commonName = checkCommonName(request.commonName);
  const dnsNames = tidy(request.dnsNames);
  for (const dns of dnsNames) {
    if (!isDnsName(dns)) throw new Error(`"${dns}" is not a valid DNS name.`);
  }
  const ipAddrs = tidy(request.ipAddrs);
  const ipAddresses = ipAddrs.map((ip) => {
    const octets = parseIpAddress(ip);
    if (octets === null) throw new Error(`"${ip}" is not a valid IP address.`);
    return octets;
  });
  // X.509 times carry whole seconds: the record states what the
  // certificate says, not a millisecond-precise approximation of it.
  const notBeforeMs = Math.floor(Date.now() / 1000) * 1000;
  const notAfterMs = checkLifetime(
    request.ttlHours ?? DEFAULT_TTL_HOURS,
    notBeforeMs,
  );

  const serial = randomSerial();
  const { der, pkcs8 } = await signSelfSignedCertificate({
    serial,
    commonName,
    dnsNames,
    ipAddresses,
    notBefore: new Date(notBeforeMs),
    notAfter: new Date(notAfterMs),
  });
  const serialHex = toHex(serial);
  return {
    certificate: toPem(der, "CERTIFICATE"),
    privateKey: toPem(pkcs8, "PRIVATE KEY"),
    caCertificate: "",
    serial: serialHex,
    commonName,
    dnsNames,
    notBefore: new Date(notBeforeMs).toISOString(),
    notAfter: new Date(notAfterMs).toISOString(),
    deliveryId: `local-${commonName}-${serialHex}`,
  };
}

/**
 * Acknowledge delivery of a locally issued certificate. Local issuance has
 * nobody to acknowledge to — the material is already in the caller's hands —
 * so this resolves immediately; it keeps the issue-then-acknowledge shape a
 * Host-issued certificate would need.
 */
async function acknowledgeLocalDelivery(_deliveryId: string): Promise<void> {}

/** Replaceable in tests; the exported functions always call through it. */
export const certsSeams = {
  issueCertificate: issueSelfSignedCertificate,
  acknowledgeCertificateDelivery: acknowledgeLocalDelivery,
};

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
