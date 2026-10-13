import { beforeAll, vi } from "vitest";
import { base64ToBytes, bytesToBase64 } from "./native-base64.js";

export const EMAIL = "reader@my-project-123.iam.gserviceaccount.com";
/** The generated key pair every test signs with, set once before the suite runs. */
let keyFile = "";
let publicKey: CryptoKey | null = null;

/** The service account key file the suite signs with. */
export function gcpKeyFile(): string {
  return keyFile;
}

export function installGcpKey(): void {
  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    publicKey = pair.publicKey;
    const der = new Uint8Array(
      await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    );
    const lines =
      bytesToBase64(der)
        .match(/.{1,64}/g)
        ?.join("\n") ?? "";
    keyFile = JSON.stringify({
      type: "service_account",
      project_id: "my-project-123",
      client_email: EMAIL,
      private_key: `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`,
      token_uri: "https://evil.example/token",
    });
  });
}

/** The public half of the key the suite signs with. */
export function gcpPublicKey(): CryptoKey {
  if (!publicKey) throw new Error("installGcpKey() has not run");
  return publicKey;
}

export const draft = (
  providerId = "gcp",
  extra: Record<string, string> = {},
) => ({
  providerId,
  displayName: "GCP",
  parameters:
    providerId === "gcp" ? { project: "my-project-123", ...extra } : {},
  credentials: { service_account_json: keyFile },
});

type Reply = { match: RegExp; body: unknown; status?: number };
export function routes(...replies: Reply[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    const reply = replies.find((entry) => entry.match.test(url));
    if (!reply) throw new Error(`Unexpected request to ${url}`);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const assertCurrent = vi.fn();
  return { fetch, calls, transport: { fetch, assertCurrent } };
}
export const token = {
  match: /oauth2\.googleapis\.com\/token$/,
  body: {
    access_token: "ya29.test-access-token-0123456789",
    expires_in: 3600,
    token_type: "Bearer",
  },
};
export const list = {
  match:
    /secretmanager\.googleapis\.com\/v1\/projects\/my-project-123\/secrets\?pageSize=20$/,
  body: {
    secrets: [
      { name: "projects/1/secrets/db-password" },
      { name: "projects/1/secrets/api_key" },
    ],
  },
};

export const b64url = (text: string) =>
  base64ToBytes(
    text
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(text.length / 4) * 4, "="),
  );
