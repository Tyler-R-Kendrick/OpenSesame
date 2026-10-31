import { asBufferSource } from "@opensesame/os-domain";
import type { CredentialItem } from "@opensesame/vault-core";
import { bytesToB64 } from "@opensesame/vault-core/bytes.js";
/** Authenticated inventory continuity travels inside its actual vault key credential. */
import { lockManager } from "../../ports.js";
import { withDeviceConfigurationLock } from "../device-connector-records.js";
import { kvDurability } from "../kv.js";
import { vaultStore } from "../vault/store.js";
import {
  type EncryptedRemoteCheckpoint as Checkpoint,
  ENCRYPTED_REMOTE_CONTINUITY_FIELD,
  type EncryptedRemoteIdentity,
  encryptedRemoteContinuityField,
  nextEncryptedRemoteContinuity,
  readEncryptedRemoteContinuity,
  encryptedRemoteContinuityError as refused,
} from "./encrypted-remote-codec.js";
import { localVaultSessionGuard } from "./local-vault-port.js";
import type { SecretBackendTransport } from "./transport.js";
import { SecretBackendError } from "./types.js";

export type EncryptedRemoteContinuity = Readonly<{
  observe(
    identity: EncryptedRemoteIdentity,
    revision: number,
    envelope: string,
  ): Promise<void>;
}>;
function same(a: Checkpoint, b: Checkpoint): boolean {
  return a.revision === b.revision && a.digest === b.digest;
}
/** The caller supplies its original custody-validated key lookup, not an arbitrary key ID. */
export function createEncryptedRemoteContinuity(
  readKey: () => CredentialItem,
  transport: SecretBackendTransport,
): EncryptedRemoteContinuity {
  const original = readKey();
  const owner = localVaultSessionGuard(vaultStore);
  if (original.method.type !== "token") {
    owner.close();
    throw refused();
  }
  const token = original.method.token;
  const locks = lockManager();
  const request = locks?.request;
  const check = () => {
    transport.assertCurrent();
    transport.signal.throwIfAborted();
    const state = owner.current();
    if (state.guest || lockManager() !== locks || locks?.request !== request)
      throw refused();
  };
  const key = () => {
    check();
    const item = readKey();
    if (
      item.id !== original.id ||
      item.method.type !== "token" ||
      item.method.token !== token ||
      item.deletedAt !== null ||
      item.accountId !== null
    )
      throw refused();
    return item;
  };
  transport.signal.addEventListener("abort", () => owner.close(), {
    once: true,
  });
  if (transport.signal.aborted) owner.close();
  return {
    async observe(identity, revision, envelope) {
      check();
      const digest = bytesToB64(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            asBufferSource(new TextEncoder().encode(envelope)),
          ),
        ),
      );
      check();
      await vaultStore.flushPendingWrites();
      check();
      if (kvDurability() !== "persistent" || !locks)
        throw new SecretBackendError(
          "configuration",
          "Persistent browser storage and Web Locks are required to preserve encrypted inventory continuity.",
        );
      await withDeviceConfigurationLock(async () => {
        const item = key();
        const before = readEncryptedRemoteContinuity(item, identity);
        const next = nextEncryptedRemoteContinuity(before, revision, digest);
        if (
          revision < before.revision ||
          (revision === before.revision && !same(before, next))
        )
          throw refused();
        if (same(before, next)) return;
        const pending = () => {
          const live = readEncryptedRemoteContinuity(key(), identity);
          if (!same(live, before) && !same(live, next)) throw refused();
        };
        pending();
        const updated = {
          ...item,
          fields: item.fields.map((row) =>
            row.id === ENCRYPTED_REMOTE_CONTINUITY_FIELD
              ? encryptedRemoteContinuityField(next)
              : row,
          ),
        };
        await vaultStore.saveItems([updated], undefined, pending);
        check();
        if (!same(readEncryptedRemoteContinuity(key(), identity), next))
          throw refused();
      });
    },
  };
}

export {
  ENCRYPTED_REMOTE_CONTINUITY_FIELD,
  encryptedRemoteContinuitySeed,
  readEncryptedRemoteContinuity,
} from "./encrypted-remote-codec.js";
