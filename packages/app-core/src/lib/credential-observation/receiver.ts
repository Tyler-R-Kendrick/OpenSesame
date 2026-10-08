import { withCredentialObservationOwner } from "../credential-canaries/owner.js";
/** Fresh-owner management is separate from the sealed-only observation sender. */
import type { OwnerProof } from "../credential-canaries/protocol.js";
import { assertNotDecoySession } from "../decoy-session.js";
import { kvDeleteDurable, kvDurability } from "../kv.js";
import { deliverObservation, revokeObservationRequests } from "./delivery.js";
import {
  type ObservationReceiverProvision,
  provisionSchema,
} from "./protocol.js";
import { appendObservation } from "./queue.js";
import {
  MAX_ATTEMPTS,
  readObservationOutbox,
  readReceiverConfig,
  receiverKey,
  withObservationLock,
  writeObservationOutbox,
  writeReceiverConfig,
} from "./storage.js";
export type OwnerInput = OwnerProof;
export type Provision = ObservationReceiverProvision;
export type ObservationReceiverStatus = {
  configured: boolean;
  receiverId?: string;
  origin?: string;
  enabled: boolean;
  verified: boolean;
  expiresAt?: string;
  queued: number;
  failed: number;
  durable: boolean;
};
export function configureObservationReceiver(
  input: OwnerInput & { provision: Provision; enabled: boolean },
): Promise<void> {
  const provision = provisionSchema.parse(input.provision);
  if (Date.parse(provision.expiresAt) <= Date.now())
    return Promise.reject(new Error("Observation receiver binding expired."));
  return withCredentialObservationOwner(
    input,
    async (vaultIdentity, assertAuthorized) => {
      await withObservationLock(input.tomb, async () => {
        const records = await readObservationOutbox(
          input.tomb,
          vaultIdentity,
          assertAuthorized,
        );
        assertAuthorized();
        revokeObservationRequests(input.tomb);
        await writeReceiverConfig(
          {
            v: 1,
            tomb: input.tomb,
            vaultIdentity,
            revision: crypto.randomUUID(),
            provision,
            enabled: false,
            verified: false,
          },
          assertAuthorized,
        );
        assertAuthorized();
        records.entries = [];
        await writeObservationOutbox(records, assertAuthorized);
        assertAuthorized();
      });
      assertAuthorized();
    },
  );
}
export async function getObservationReceiverStatus(
  tomb: string,
): Promise<ObservationReceiverStatus> {
  const realm = assertNotDecoySession();
  const check = () => {
    assertNotDecoySession(realm);
  };
  return withObservationLock(tomb, async () => {
    const config = await readReceiverConfig(tomb, check);
    check();
    if (!config)
      return {
        configured: false,
        enabled: false,
        verified: false,
        queued: 0,
        failed: 0,
        durable: kvDurability() === "persistent",
      };
    const records = await readObservationOutbox(
      tomb,
      config.vaultIdentity,
      check,
    );
    check();
    const live = Date.parse(config.provision.expiresAt) > Date.now();
    return {
      configured: true,
      receiverId: config.provision.receiverId,
      origin: config.provision.origin,
      enabled: config.enabled && live,
      verified: config.verified && live,
      expiresAt: config.provision.expiresAt,
      queued: records.entries.filter(
        (e) =>
          !e.testing &&
          e.attempts < MAX_ATTEMPTS &&
          Date.parse(e.package.expiresAt) > Date.now(),
      ).length,
      failed: records.failed,
      durable: kvDurability() === "persistent",
    };
  });
}
export type ObservationReceiverTestResult = { delivered: boolean };
export async function testObservationReceiver(
  input: OwnerInput,
): Promise<ObservationReceiverTestResult> {
  const prepared = await withCredentialObservationOwner(
    input,
    async (vaultIdentity, assertAuthorized) => {
      const realm = assertNotDecoySession();
      const value = await withObservationLock(input.tomb, async () => {
        const config = await readReceiverConfig(input.tomb, assertAuthorized);
        assertAuthorized();
        if (!config || config.vaultIdentity !== vaultIdentity)
          throw new Error("Configure an observation receiver first.");
        const packet = await appendObservation(
          config,
          {
            v: 1,
            eventId: crypto.randomUUID(),
            vaultIdentity,
            event: { type: "receiver_test" },
            at: new Date().toISOString(),
          },
          true,
          assertAuthorized,
        );
        assertAuthorized();
        return { config, packet, realm };
      });
      assertAuthorized();
      return value;
    },
  );
  if (!prepared.packet) return { delivered: false };
  assertNotDecoySession(prepared.realm);
  const delivered = await deliverObservation(
    input.tomb,
    prepared.packet.packageId,
    true,
  );
  assertNotDecoySession(prepared.realm);
  if (!delivered) return { delivered: false };
  await withCredentialObservationOwner(
    input,
    async (vaultIdentity, assertAuthorized) => {
      await withObservationLock(input.tomb, async () => {
        const current = await readReceiverConfig(input.tomb, assertAuthorized);
        assertAuthorized();
        if (
          !current ||
          current.revision !== prepared.config.revision ||
          current.vaultIdentity !== vaultIdentity
        )
          throw new Error("Observation receiver changed before verification.");
        current.verified = true;
        await writeReceiverConfig(current, assertAuthorized);
        assertAuthorized();
      });
      assertAuthorized();
    },
  );
  return { delivered: true };
}
export function setObservationReceiverEnabled(
  input: OwnerInput & { enabled: boolean },
): Promise<void> {
  return withCredentialObservationOwner(
    input,
    async (identity, assertAuthorized) => {
      await withObservationLock(input.tomb, async () => {
        const config = await readReceiverConfig(input.tomb, assertAuthorized);
        assertAuthorized();
        if (!config || config.vaultIdentity !== identity)
          throw new Error("Configure an observation receiver first.");
        if (
          input.enabled &&
          (!config.verified ||
            Date.parse(config.provision.expiresAt) <= Date.now())
        )
          throw new Error(
            "Test the observation receiver before enabling delivery.",
          );
        const records = await readObservationOutbox(
          input.tomb,
          identity,
          assertAuthorized,
        );
        assertAuthorized();
        revokeObservationRequests(input.tomb);
        config.enabled = input.enabled;
        config.revision = crypto.randomUUID();
        await writeReceiverConfig(config, assertAuthorized);
        assertAuthorized();
        records.entries = [];
        await writeObservationOutbox(records, assertAuthorized);
        assertAuthorized();
      });
      assertAuthorized();
    },
  );
}
export function removeObservationReceiver(input: OwnerInput): Promise<void> {
  return withCredentialObservationOwner(
    input,
    async (identity, assertAuthorized) => {
      await withObservationLock(input.tomb, async () => {
        const config = await readReceiverConfig(input.tomb, assertAuthorized);
        assertAuthorized();
        if (!config) return;
        const records = await readObservationOutbox(
          input.tomb,
          identity,
          assertAuthorized,
        );
        assertAuthorized();
        revokeObservationRequests(input.tomb);
        config.enabled = false;
        config.verified = false;
        config.revision = crypto.randomUUID();
        await writeReceiverConfig(config, assertAuthorized);
        assertAuthorized();
        records.entries = [];
        await writeObservationOutbox(records, assertAuthorized);
        assertAuthorized();
        await kvDeleteDurable(receiverKey(input.tomb));
        assertAuthorized();
      });
      assertAuthorized();
    },
  );
}
