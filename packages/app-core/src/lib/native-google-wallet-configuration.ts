import {
  GOOGLE_WALLET_CONFIGURATION_POLICY as POLICY,
  googleWalletPemParts,
  googleWalletPublicFailure,
} from "@opensesame/wallet/google-wallet-policy";
import { base64ToBytes } from "./native-base64.js";
import { asBufferSource } from "@opensesame/os-domain";

export function validateGoogleWalletPublic(
  parameters: Record<string, string>,
): void {
  const failure = googleWalletPublicFailure(
    parameters.issuer_id ?? "",
    parameters.class_id ?? "",
    parameters.service_account_email ?? "",
  );
  if (failure === "issuer_id")
    throw new Error("Enter the numeric Google Wallet issuer id");
  if (failure === "class_id")
    throw new Error("Enter a Google Wallet class id belonging to this issuer");
  if (failure === "service_account_email")
    throw new Error("Enter a valid service account email");
}

export async function validateGoogleWalletKey(raw: string): Promise<void> {
  try {
    const parts = googleWalletPemParts(raw);
    if (!parts) throw new Error("Invalid private key envelope");
    await crypto.subtle.importKey(
      POLICY.key.format,
      asBufferSource(base64ToBytes(parts.body)),
      { name: POLICY.key.algorithm, hash: POLICY.key.hash },
      false,
      [POLICY.key.usage],
    );
  } catch {
    throw new Error("Enter a valid PKCS#8 RSA private key");
  }
}
