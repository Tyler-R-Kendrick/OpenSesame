import {
  safeNativeConnectorIcon,
  safeProviderText,
} from "./native-api-verify.js";
import { base64ToBytes } from "./native-base64.js";
import type { NativeCatalogConfiguration } from "./native-catalog-contract.js";
import type { NativeDriverInput } from "./native-connector-drivers.js";

const PEM =
  /^-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]{200,32768})-----END PRIVATE KEY-----\s*$/;

function validateGoogleWalletPublic(parameters: Record<string, string>): void {
  const issuer = parameters.issuer_id ?? "";
  const classId = parameters.class_id ?? "";
  const email = parameters.service_account_email ?? "";
  if (!/^\d{6,32}$/.test(issuer))
    throw new Error("Enter the numeric Google Wallet issuer id");
  const prefix = `${issuer}.`;
  const qualified = classId.startsWith(prefix);
  const suffix = qualified ? classId.slice(prefix.length) : classId;
  if (
    (classId.includes(".") && !qualified) ||
    !/^[A-Za-z0-9._-]+$/.test(suffix)
  )
    throw new Error("Enter a Google Wallet class id belonging to this issuer");
  if (email.length > 320 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    throw new Error("Enter a valid service account email");
}

async function validateGoogleWalletKey(raw: string): Promise<void> {
  try {
    if (raw.length > 32768) throw new Error("Key too large");
    const pem = raw.replace(/\\n/g, "\n").trim();
    const body = PEM.exec(pem)?.[1]?.replace(/\s+/g, "") ?? "";
    await crypto.subtle.importKey(
      "pkcs8",
      base64ToBytes(body),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new Error("Enter a valid PKCS#8 RSA private key");
  }
}

export async function validateNativeCatalogValues(
  contract: NativeCatalogConfiguration,
  input: NativeDriverInput,
  parameters: Record<string, string>,
  credentials: Record<string, string>,
): Promise<void> {
  const comparableCredentials = Object.fromEntries(
    Object.entries(credentials).map(([name, value]) => [name, value.trim()]),
  );
  safeProviderText(input.displayName, comparableCredentials);
  safeNativeConnectorIcon(input.icon ?? "", comparableCredentials);
  for (const value of Object.values(parameters))
    safeProviderText(value, comparableCredentials);
  if (contract.provider.id === "google-wallet") {
    validateGoogleWalletPublic(parameters);
    await validateGoogleWalletKey(credentials.service_account_key ?? "");
  }
}
