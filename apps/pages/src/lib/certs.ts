/**
 * Host private CA / dev-certificate client (Infisical-style).
 * Leaf private keys are returned once and stored in the device vault.
 */

import {
  type JsonObject,
  isString,
  overlapCast,
  readJsonObject,
  readString,
} from "@opensesame/os-domain";
import { hostFetch } from "./identity.js";

export type IssuedCertificate = {
  certificate: string;
  privateKey: string;
  caCertificate: string;
  serial: string;
  commonName: string;
  dnsNames: string[];
  notBefore: string;
  notAfter: string;
  deliveryId?: string;
};

async function fail(res: Response, fallback: string): Promise<never> {
  const body = overlapCast(await res.json().catch(() => ({})));
  throw new Error(
    readString(body.hint) ||
      readString(body.error) ||
      `${fallback} (${res.status})`,
  );
}

function toIssued(raw: JsonObject): IssuedCertificate {
  const dns = Array.isArray(raw.dns_names)
    ? raw.dns_names.filter(isString)
    : [];
  const certificate = readString(raw.certificate);
  const privateKey = readString(raw.private_key);
  const caCertificate = readString(raw.ca_certificate) ?? "";
  const commonName = readString(raw.common_name);
  const notAfter = readString(raw.not_after);
  if (!certificate || !privateKey || !commonName || !notAfter) {
    throw new Error("Host returned incomplete certificate material");
  }
  const deliveryId = readString(raw.delivery_id);
  return {
    certificate,
    privateKey,
    caCertificate,
    serial: String(raw.serial ?? ""),
    commonName,
    dnsNames: dns,
    notBefore: String(raw.not_before ?? ""),
    notAfter,
    ...(deliveryId ? { deliveryId } : undefined),
  };
}

async function acknowledgeCertificateDeliveryDefault(
  deliveryId: string,
): Promise<void> {
  const res = await hostFetch(
    `/api/v1/certs/deliveries/${encodeURIComponent(deliveryId)}/ack`,
    { method: "POST" },
  );
  if (!res.ok) await fail(res, "Could not acknowledge certificate delivery");
}

async function issueCertificateDefault(input: {
  commonName: string;
  dnsNames?: string[];
  ipAddrs?: string[];
  ttlHours?: number;
  idempotencyKey?: string;
}): Promise<IssuedCertificate> {
  const headers = new Headers({ "content-type": "application/json" });
  if (input.idempotencyKey)
    headers.set("idempotency-key", input.idempotencyKey);
  const res = await hostFetch("/api/v1/certs/issue", {
    method: "POST",
    headers,
    body: JSON.stringify({
      common_name: input.commonName,
      dns_names: input.dnsNames ?? [],
      ip_addrs: input.ipAddrs ?? [],
      ttl_hours: input.ttlHours ?? 24,
    }),
  });
  if (!res.ok) await fail(res, "Could not issue certificate");
  const body = overlapCast(await res.json());
  return toIssued(readJsonObject(body) ?? body);
}

export const certsSeams = {
  issueCertificate: issueCertificateDefault,
  acknowledgeCertificateDelivery: acknowledgeCertificateDeliveryDefault,
};

export async function issueCertificate(
  input: Parameters<typeof issueCertificateDefault>[0],
): Promise<IssuedCertificate> {
  return certsSeams.issueCertificate(input);
}

export async function acknowledgeCertificateDelivery(
  deliveryId: string,
): Promise<void> {
  return certsSeams.acknowledgeCertificateDelivery(deliveryId);
}
