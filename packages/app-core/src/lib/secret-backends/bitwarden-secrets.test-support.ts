import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createRequire } from "node:module";
import { z } from "zod";
import type { BitwardenSdkFactory } from "./bitwarden-wasm-loader.js";
import {
  type CapturedSecretRequest,
  type FixtureReply,
  secretHttpFixture,
} from "./onepassword-http.test-support.js";

type SecretsSdk = typeof import("@bitwarden/sdk-wasm");
const sdkRequire = createRequire(import.meta.url);
export const nativeSecretsClient: BitwardenSdkFactory = async (settings) => {
  // Mirror the production per-worker WASM isolation, including its logger singleton.
  const modulePath = sdkRequire.resolve("@bitwarden/sdk-wasm");
  delete sdkRequire.cache[modulePath];
  const sdk: SecretsSdk = sdkRequire("@bitwarden/sdk-wasm");
  return new sdk.BitwardenClient(JSON.stringify(settings), sdk.LogLevel.Error);
};
export const organizationId = "00000000-0000-4000-8000-000000000001";
export const projectId = "00000000-0000-4000-8000-000000000002";
// Public SDK unit-test vector, not a real machine-account credential.
export const accessToken =
  "0.ec2c1d46-6a4b-4751-a310-af9601317f2d.C2IgxjjLF7qSshsbwe8JGcbM075YXw:X8vbvA0bduihIDe/qrzIQQ==";
const tokenEncryptionKey = Buffer.from(
  hkdfSync(
    "sha256",
    Buffer.from("X8vbvA0bduihIDe/qrzIQQ==", "base64"),
    "bitwarden-accesstoken",
    "sm-access-token",
    64,
  ),
);

/** Independently implement only the test server's documented Bitwarden EncString wire format. */
function encrypt(value: string, key: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key.subarray(0, 32), iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const mac = createHmac("sha256", key.subarray(32))
    .update(Buffer.concat([iv, encrypted]))
    .digest();
  return `2.${iv.toString("base64")}|${encrypted.toString("base64")}|${mac.toString("base64")}`;
}
function decrypt(value: string, key: Buffer): string {
  if (!value.startsWith("2."))
    throw new Error("Expected authenticated encrypted data");
  const [ivText = "", ciphertextText = "", macText = ""] = value
    .slice(2)
    .split("|");
  const iv = Buffer.from(ivText, "base64");
  const ciphertext = Buffer.from(ciphertextText, "base64");
  const mac = createHmac("sha256", key.subarray(32))
    .update(Buffer.concat([iv, ciphertext]))
    .digest();
  if (!timingSafeEqual(mac, Buffer.from(macText, "base64")))
    throw new Error("Invalid MAC");
  const cipher = createDecipheriv("aes-256-cbc", key.subarray(0, 32), iv);
  return Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString(
    "utf8",
  );
}
const WriteSchema = z.object({
  key: z.string(),
  value: z.string(),
  note: z.string(),
  projectIds: z.array(z.string()).optional(),
});
type SecretFixtureRecord = z.infer<typeof WriteSchema> & { id: string };

type FixtureState = {
  rejectAuthentication: boolean;
  corruptPayload: boolean;
  corruptSecret: boolean;
};
type FixtureContext = {
  orgKey: Buffer;
  items: Map<string, SecretFixtureRecord>;
  state: FixtureState;
  bearer: string;
};

function wire(item: SecretFixtureRecord, context: FixtureContext) {
  const encryptedValue = encrypt(item.value, context.orgKey);
  return {
    object: "secret",
    id: item.id,
    organizationId,
    key: encrypt(item.key, context.orgKey),
    value: context.state.corruptSecret
      ? `${encryptedValue.slice(0, -3)}AAA`
      : encryptedValue,
    note: encrypt(item.note, context.orgKey),
    creationDate: "2026-10-14T00:00:00Z",
    revisionDate: "2026-10-14T00:00:00Z",
    projects: (item.projectIds ?? []).map((id) => ({ id })),
    read: true,
    write: true,
  };
}
function authenticate(
  request: CapturedSecretRequest,
  context: FixtureContext,
): FixtureReply {
  const form = new URLSearchParams(request.body);
  if (
    context.state.rejectAuthentication ||
    form.get("client_id") !== "ec2c1d46-6a4b-4751-a310-af9601317f2d" ||
    form.get("client_secret") !== "C2IgxjjLF7qSshsbwe8JGcbM075YXw" ||
    form.get("scope") !== "api.secrets" ||
    form.get("grant_type") !== "client_credentials"
  )
    return { status: 400, body: '{"error":"invalid_client"}' };
  const payload = encrypt(
    JSON.stringify({ encryptionKey: context.orgKey.toString("base64") }),
    tokenEncryptionKey,
  );
  return {
    body: JSON.stringify({
      access_token: context.bearer,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "api.secrets",
      encrypted_payload: context.state.corruptPayload
        ? `${payload.slice(0, -3)}AAA`
        : payload,
    }),
  };
}
function writeSecret(
  request: CapturedSecretRequest,
  context: FixtureContext,
): FixtureReply {
  const input = WriteSchema.parse(JSON.parse(request.body));
  const plain = {
    key: decrypt(input.key, context.orgKey),
    value: decrypt(input.value, context.orgKey),
    note: decrypt(input.note, context.orgKey),
    projectIds: input.projectIds,
  };
  const id =
    request.method === "POST"
      ? crypto.randomUUID()
      : request.path.slice("/api/secrets/".length);
  const record = { ...plain, id };
  context.items.set(id, record);
  return { body: JSON.stringify(wire(record, context)) };
}
function handleRequest(
  request: CapturedSecretRequest,
  context: FixtureContext,
): FixtureReply {
  if (request.path === "/identity/connect/token")
    return authenticate(request, context);
  if (request.headers.authorization !== `Bearer ${context.bearer}`)
    return { status: 401 };
  const root = `/api/organizations/${organizationId}/secrets`;
  if (request.path === root && request.method === "GET")
    return {
      body: JSON.stringify({
        object: "secrets",
        secrets: [...context.items.values()].map((item) => wire(item, context)),
        projects: [],
      }),
    };
  if (
    (request.path === root && request.method === "POST") ||
    (request.path.startsWith("/api/secrets/") && request.method === "PUT")
  )
    return writeSecret(request, context);
  if (request.path === "/api/secrets/delete" && request.method === "POST") {
    const ids = z.array(z.string()).parse(JSON.parse(request.body));
    for (const id of ids) context.items.delete(id);
    return {
      body: JSON.stringify({
        object: "list",
        data: ids.map((id) => ({ id, error: null })),
      }),
    };
  }
  const id = request.path.slice("/api/secrets/".length);
  const record = context.items.get(id);
  if (record && request.method === "GET")
    return { body: JSON.stringify(wire(record, context)) };
  return { status: 404, body: '{"message":"not found"}' };
}
export async function secretsManagerFixture(port = 0) {
  const context: FixtureContext = {
    orgKey: randomBytes(64),
    items: new Map(),
    state: {
      rejectAuthentication: false,
      corruptPayload: false,
      corruptSecret: false,
    },
    bearer: "",
  };
  const jwtPayload = Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: "fixture-machine",
      organization: organizationId,
      scope: ["api.secrets"],
    }),
  ).toString("base64url");
  context.bearer = `eyJhbGciOiJSUzI1NiJ9.${jwtPayload}.test-signature`;
  const server = await secretHttpFixture(
    (request) => handleRequest(request, context),
    port,
  );
  return {
    ...server,
    state: context.state,
    items: context.items,
    organizationId,
    projectId,
  };
}
