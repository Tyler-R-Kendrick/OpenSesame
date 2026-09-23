/**
 * Hosted persistent Google Wallet launcher registration (ADR 0086 / W-01).
 *
 * Browser-local authority does not need this path; the Identity API owns the
 * registration record and the Save URL. When Identity is absent the helpers
 * refuse closed rather than inventing a local Google signature.
 */

import {
  type JsonObject,
  isBoolean,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { identityFetch, isRemoteIdentityConfigured } from "./identity.js";

export type WalletRegistrationWire = {
  registrationId: string;
  state: "active" | "disabled";
  passId: string;
  createdAt: string;
  disabledAt?: string;
};

export type WalletRegisterResult = WalletRegistrationWire & {
  saveUrl: string;
  reissued: boolean;
  rotatingBarcodeProvisioned: boolean;
};

export class WalletRegistrationUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletRegistrationUnavailable";
  }
}

function requireIdentity(): void {
  if (!isRemoteIdentityConfigured()) {
    throw new WalletRegistrationUnavailable(
      "Add to Google Wallet needs a connected sign-in service; the local vault still approves without it.",
    );
  }
}

function readErrorMessage(body: JsonObject): string | null {
  const error = body.error;
  if (!isString(error) || error.length === 0) return null;
  const reason = body.reason;
  return isString(reason) && reason.length > 0 ? `${error}: ${reason}` : error;
}

async function readError(res: Response): Promise<string> {
  try {
    const parsed = overlapCast(await res.json());
    if (isJsonObject(parsed)) {
      const message = readErrorMessage(parsed);
      if (message !== null) return message;
    }
  } catch {
    // fall through
  }
  return `wallet registration failed (${res.status})`;
}

function parseRegistration(value: JsonObject): WalletRegistrationWire | null {
  if (
    !isString(value.registrationId) ||
    !isString(value.passId) ||
    !isString(value.createdAt) ||
    (value.state !== "active" && value.state !== "disabled")
  ) {
    return null;
  }
  const wire: WalletRegistrationWire = {
    registrationId: value.registrationId,
    state: value.state,
    passId: value.passId,
    createdAt: value.createdAt,
  };
  if (isString(value.disabledAt)) {
    wire.disabledAt = value.disabledAt;
  }
  return wire;
}

function parseRegisterResult(value: JsonObject): WalletRegisterResult | null {
  const base = parseRegistration(value);
  if (
    base === null ||
    !isString(value.saveUrl) ||
    !isBoolean(value.reissued) ||
    !isBoolean(value.rotatingBarcodeProvisioned)
  ) {
    return null;
  }
  return {
    ...base,
    saveUrl: value.saveUrl,
    reissued: value.reissued,
    rotatingBarcodeProvisioned: value.rotatingBarcodeProvisioned,
  };
}

export async function listWalletRegistrations(): Promise<
  readonly WalletRegistrationWire[]
> {
  requireIdentity();
  const res = await identityFetch("/v1/wallet/registrations");
  if (res.status === 501) {
    throw new WalletRegistrationUnavailable(
      "This Identity deployment has not mounted wallet registration.",
    );
  }
  if (!res.ok) throw new Error(await readError(res));
  const parsed = overlapCast(await res.json());
  if (!isJsonObject(parsed)) return [];
  const list = parsed.registrations;
  if (!Array.isArray(list)) return [];
  const out: WalletRegistrationWire[] = [];
  for (const entry of list) {
    if (!isJsonObject(entry)) continue;
    const row = parseRegistration(entry);
    if (row !== null) out.push(row);
  }
  return out;
}

export async function registerWalletLauncher(input: {
  registrationId: string;
  header: string;
  subtitle?: string;
  rotatingBarcode?: boolean;
}): Promise<WalletRegisterResult> {
  requireIdentity();
  const res = await identityFetch("/v1/wallet/registrations", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (res.status === 501) {
    throw new WalletRegistrationUnavailable(
      "This Identity deployment has not mounted wallet registration.",
    );
  }
  if (res.status === 503 || res.status === 400) {
    const message = await readError(res);
    if (message.includes("not_configured") || message.includes("No wallet")) {
      throw new WalletRegistrationUnavailable(
        "Google Wallet is not configured on this Identity deployment.",
      );
    }
    throw new Error(message);
  }
  if (!res.ok) throw new Error(await readError(res));
  const parsed = overlapCast(await res.json());
  if (!isJsonObject(parsed)) {
    throw new Error("wallet registration returned a malformed body");
  }
  const result = parseRegisterResult(parsed);
  if (result === null) {
    throw new Error("wallet registration returned a malformed body");
  }
  return result;
}

export async function disableWalletLauncher(
  registrationId: string,
): Promise<WalletRegistrationWire & { googleAcknowledged: boolean }> {
  requireIdentity();
  const res = await identityFetch(
    `/v1/wallet/registrations/${encodeURIComponent(registrationId)}/disable`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(await readError(res));
  const parsed = overlapCast(await res.json());
  if (!isJsonObject(parsed)) {
    throw new Error("wallet disable returned a malformed body");
  }
  const base = parseRegistration(parsed);
  if (base === null || !isBoolean(parsed.googleAcknowledged)) {
    throw new Error("wallet disable returned a malformed body");
  }
  return {
    ...base,
    googleAcknowledged: parsed.googleAcknowledged,
  };
}
