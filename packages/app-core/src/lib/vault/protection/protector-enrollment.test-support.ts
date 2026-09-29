import { AWS_KMS_CONFIG_PATH } from "../../aws-kms-config.js";
import { kvDelete } from "../../kv.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "../../vfs.js";
import { ATTEMPTS_KEY, VaultStore } from "../store.js";
import { LEGACY_PREFS_KEY } from "../tomb-migration.js";
import type { AwsKmsTransport } from "./adapters/aws-kms.js";
import type { GcpKmsTransport } from "./adapters/gcp-kms.js";
import { ProtectionError } from "./errors.js";

export const PASSWORD = "correct horse battery staple";
export const HEADER_KEY = tombFileKey(PERSONAL_TOMB, HEADER_PATH);
export const KEY_ARN =
  "arn:aws:kms:us-west-2:123456789012:key/12345678-1234-1234-1234-1234567890ab";
export const OTHER_ARN =
  "arn:aws:kms:us-west-2:123456789012:key/ffffffff-1234-1234-1234-1234567890ab";
export const GCP_KEY =
  "projects/p1/locations/global/keyRings/ring/cryptoKeys/vault-root";

export async function clearVaultSurface(): Promise<void> {
  await vfsFlush();
  kvDelete(ATTEMPTS_KEY);
  kvDelete(HEADER_KEY);
  kvDelete(tombFileKey(PERSONAL_TOMB, BODY_PATH));
  kvDelete(tombFileKey(PERSONAL_TOMB, MIGRATION_MARKER_PATH));
  kvDelete(tombFileKey(PERSONAL_TOMB, INDEX_PATH));
  kvDelete(tombFileKey(PERSONAL_TOMB, AWS_KMS_CONFIG_PATH));
  kvDelete(LEGACY_PREFS_KEY);
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** An honest KMS: keeps the 32-byte secret it was given, per key. */
type FakeOptions = { deny?: boolean };

export function awsFake(arn: string, opts: FakeOptions = {}) {
  const held = new Map<string, Uint8Array>();
  const transport: AwsKmsTransport = {
    async encrypt(request) {
      if (opts.deny) throw new ProtectionError("provider_denied", "denied");
      const ct = crypto.getRandomValues(new Uint8Array(48));
      held.set(
        `${request.keyArn}|${b64(ct)}`,
        new Uint8Array(request.plaintext),
      );
      return { ciphertext: ct, keyId: request.keyArn };
    },
    async decrypt(request) {
      if (opts.deny) throw new ProtectionError("provider_denied", "denied");
      const secret = held.get(
        `${request.expectedKeyArn}|${b64(request.ciphertext)}`,
      );
      if (!secret) throw new ProtectionError("provider_denied", "no such key");
      return { plaintext: new Uint8Array(secret), keyId: arn };
    },
  };
  return transport;
}

export function gcpFake(onEncrypt?: () => void) {
  const held = new Map<string, Uint8Array>();
  const transport: GcpKmsTransport = {
    async encrypt(request) {
      onEncrypt?.();
      const ct = crypto.getRandomValues(new Uint8Array(48));
      held.set(b64(ct), new Uint8Array(request.plaintext));
      return {
        ciphertext: ct,
        keyVersionName: `${request.keyName}/cryptoKeyVersions/1`,
      };
    },
    async decrypt(request) {
      const secret = held.get(b64(request.ciphertext));
      if (!secret) throw new ProtectionError("provider_denied", "no such key");
      return { plaintext: new Uint8Array(secret) };
    },
  };
  return transport;
}

export function aws(transport: AwsKmsTransport, keyArn = KEY_ARN) {
  return {
    kind: "aws-kms" as const,
    transport,
    keyArn,
    region: "us-west-2",
    connectionId: "aws-kms",
    connectionConfigVersion: "1",
  };
}

export async function openStore(): Promise<VaultStore> {
  const store = new VaultStore();
  await store.create(PASSWORD);
  return store;
}

export async function reopen(store: VaultStore): Promise<VaultStore> {
  store.lock();
  const again = new VaultStore();
  await again.unlock(PASSWORD);
  return again;
}
