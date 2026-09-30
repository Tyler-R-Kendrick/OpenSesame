/**
 * Self-signed issuance for `vault.certificate-records` (ADR 0153).
 * The vault editor calls `issueCertificate`; this module is what that
 * function runs once the capability has installed it.
 */
import {
  type CertificateRequest,
  type IssuedCertificate,
  installCertificateIssuance,
} from "./certs.js";
import {
  randomSerial,
  signSelfSignedCertificate,
  toHex,
} from "./x509/certificate.js";
import { toPem } from "./x509/der.js";
import { isDnsName, parseIpAddress } from "./x509/names.js";

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
export async function issueSelfSignedCertificate(
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

export function installLocalCertificateIssuance(): void {
  installCertificateIssuance(issueSelfSignedCertificate);
}
