import {
  objectIdentifier,
  octetString,
  sequence,
  smallInteger,
  tlv,
} from "./der.js";
/** GitHub App assertions are signed locally; the private key never leaves this device. */
import {
  base64ToBytes,
  bytesToBase64Url,
  textToBase64Url,
} from "./native-base64.js";

export type GithubDirectGuard = {
  signal: AbortSignal;
  /** Recheck the captured unlocked vault and approved Git capability. */
  assertCurrent(): void;
};

export class GithubDirectError extends Error {
  constructor(
    public readonly code:
      | "configuration"
      | "cancelled"
      | "key"
      | "network"
      | "response"
      | "authorization",
    message: string,
  ) {
    super(message);
    this.name = "GithubDirectError";
  }
}

export function assertGithubCurrent(guard: GithubDirectGuard): void {
  if (guard.signal.aborted)
    throw new GithubDirectError("cancelled", "GitHub request cancelled.");
  guard.assertCurrent();
}

function privateKeyBytes(pem: string): Uint8Array {
  const match =
    pem.length <= 65536 &&
    /^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----\s*([A-Za-z0-9+/=\s]+)-----END \1-----\s*$/.exec(
      pem,
    );
  if (!match)
    throw new GithubDirectError(
      "key",
      "Enter an unencrypted RSA private key in PEM format.",
    );
  try {
    const bytes = base64ToBytes((match[2] ?? "").replace(/\s/g, ""));
    if (match[1] !== "RSA PRIVATE KEY") return bytes;
    try {
      return sequence(
        smallInteger(0),
        sequence(
          objectIdentifier("1.2.840.113549.1.1.1"),
          tlv(0x05, new Uint8Array()),
        ),
        octetString(bytes),
      );
    } finally {
      bytes.fill(0);
    }
  } catch {
    throw new GithubDirectError(
      "key",
      "That RSA private key could not be read.",
    );
  }
}

export async function signGithubAppJwt(
  appId: string,
  pem: string,
  guard: GithubDirectGuard,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  assertGithubCurrent(guard);
  if (
    !/^[A-Za-z0-9._-]{1,128}$/.test(appId) ||
    !Number.isSafeInteger(nowSeconds) ||
    nowSeconds < 60
  )
    throw new GithubDirectError(
      "configuration",
      "Enter a valid GitHub App ID or client ID.",
    );
  const der = privateKeyBytes(pem);
  const keyData = new Uint8Array(der);
  const signingInput = `${textToBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${textToBase64Url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }))}`;
  try {
    const key = await crypto.subtle.importKey(
      "pkcs8",
      keyData,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    assertGithubCurrent(guard);
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(signingInput),
    );
    assertGithubCurrent(guard);
    return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
  } catch (error) {
    assertGithubCurrent(guard);
    if (error instanceof GithubDirectError) throw error;
    throw new GithubDirectError(
      "key",
      "That RSA private key could not sign a GitHub App assertion.",
    );
  } finally {
    der.fill(0);
    keyData.fill(0);
  }
}
