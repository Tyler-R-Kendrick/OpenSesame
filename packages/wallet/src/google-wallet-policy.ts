/** Shared Google Wallet configuration rules compiled from the connector spec. */
import { GOOGLE_WALLET_CONFIGURATION_POLICY as POLICY } from "./google-wallet-policy.generated.js";

export type GoogleWalletFieldFailure =
  | "issuer_id"
  | "class_id"
  | "service_account_email";

export function googleWalletPublicFailure(
  issuer: string,
  classId: string,
  email: string,
): GoogleWalletFieldFailure | null {
  if (!new RegExp(POLICY.issuer.pattern).test(issuer)) return "issuer_id";
  if (POLICY.walletClass.qualification !== "unqualified-or-this-issuer")
    throw new Error("Unsupported Google Wallet class qualification");
  const prefix = `${issuer}${POLICY.walletClass.issuerSeparator}`;
  const qualified = classId.startsWith(prefix);
  const suffix = qualified ? classId.slice(prefix.length) : classId;
  if (
    (classId.includes(POLICY.walletClass.issuerSeparator) && !qualified) ||
    !new RegExp(POLICY.walletClass.suffixPattern).test(suffix)
  )
    return "class_id";
  if (
    email.length > POLICY.email.maxLength ||
    !new RegExp(POLICY.email.pattern).test(email)
  )
    return "service_account_email";
  return null;
}

export function normalizeGoogleWalletPem(raw: string): string {
  return POLICY.key.escapedNewlines && raw.includes("-----BEGIN")
    ? raw.replace(/\\n/g, "\n")
    : raw;
}

/** Validate the PEM envelope; callers must also perform the specified key import. */
export function googleWalletPemParts(
  raw: string,
): { pem: string; body: string } | null {
  if (raw.length > POLICY.key.maxRawLength) return null;
  const pem = normalizeGoogleWalletPem(raw).trim();
  const body = new RegExp(POLICY.key.pemPattern)
    .exec(pem)?.[1]
    ?.replace(/\s+/g, "");
  if (!body) return null;
  try {
    atob(body);
  } catch {
    return null;
  }
  return { pem, body };
}

export { GOOGLE_WALLET_CONFIGURATION_POLICY } from "./google-wallet-policy.generated.js";
