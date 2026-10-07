import { expect, it } from "vitest";
import { kvSet } from "../kv.js";
import {
  recordRetiredDecoyInteraction,
  retiredCredentialStatus,
} from "../retired-credentials/index.js";
import { flushRetiredCredentialTelemetry } from "../retired-credentials/telemetry-queue.js";
import { unlockWithRetiredCredentialGate } from "../retired-credentials/unlock.js";
import {
  configureObservationReceiver,
  setObservationReceiverEnabled,
  testObservationReceiver,
} from "./receiver.js";
import {
  ObservationReferenceReceiver,
  type ObservationReferenceState,
} from "./reference.js";
import { receiverKey } from "./storage.js";
import { fixture, listen, owner, provision } from "./test-support.js";

type PersistedReceiver = { value: ObservationReferenceState | null };

it("routes the portable retired unlock and synthetic activity to sealed metadata without granting real admission", async () => {
  const f = await fixture();
  await f.enroll("retired-reject");
  await f.enroll("retired-decoy", "synthetic_decoy");
  const trap = retiredCredentialStatus(owner.tomb).traps.find(
    (t) => t.response === "synthetic_decoy",
  );
  if (!trap) throw new Error("Missing synthetic trap fixture");
  const persisted: PersistedReceiver = {
    value: null,
  };
  const wire: string[] = [];
  const origin = await listen(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part.toString();
    wire.push(raw);
    try {
      res.end(JSON.stringify(await receiver.receive(raw)));
    } catch {
      res.writeHead(400).end();
    }
  });
  const p = provision(origin);
  const receiver = new ObservationReferenceReceiver(p, {
    async read() {
      return persisted.value === null ? null : structuredClone(persisted.value);
    },
    async write(value) {
      persisted.value = structuredClone(value);
    },
  });
  await configureObservationReceiver({
    ...owner,
    provision: p,
    enabled: false,
  });
  expect(await testObservationReceiver(owner)).toEqual({ delivered: true });
  await setObservationReceiverEnabled({ ...owner, enabled: true });
  f.store.lock();
  await expect(
    unlockWithRetiredCredentialGate(f.store, "retired-reject"),
  ).rejects.toThrow();
  expect(f.store.getSnapshot().status).toBe("locked");
  await flushRetiredCredentialTelemetry();
  expect(retiredCredentialStatus(owner.tomb).events).toContainEqual(
    expect.objectContaining({
      type: "retired_credential_observed",
      response: "reject",
    }),
  );
  expect(await unlockWithRetiredCredentialGate(f.store, "retired-decoy")).toBe(
    "retired_credential_session",
  );
  expect(f.store.getSnapshot()).toMatchObject({
    status: "unlocked",
    guest: true,
    decoy: true,
  });
  await recordRetiredDecoyInteraction(owner.tomb, trap.id, "authority_denied");
  await flushRetiredCredentialTelemetry();
  const events = persisted.value?.receipts.map((r) => r.metadata.event) ?? [];
  expect(events).toContainEqual({
    type: "retired_credential_observed",
    trapId: trap.id,
    response: "synthetic_decoy",
  });
  expect(events).toContainEqual({
    type: "synthetic_decoy_interaction",
    trapId: trap.id,
    response: "synthetic_decoy",
    action: "authority_denied",
  });
  expect(wire.length).toBeGreaterThanOrEqual(4);
  for (const raw of wire) {
    expect(raw).not.toContain(owner.currentPassword);
    expect(raw).not.toContain("retired-reject");
    expect(raw).not.toContain("retired-decoy");
    expect(raw).not.toContain(f.identity);
    expect(raw).not.toContain(trap.id);
  }
});

it("preserves actual rejection and durable local evidence when optional receiver state is corrupt", async () => {
  const f = await fixture();
  await f.enroll("retired-secret");
  kvSet(receiverKey(owner.tomb), "invalid receiver state");
  f.store.lock();
  await expect(
    unlockWithRetiredCredentialGate(f.store, "retired-secret"),
  ).rejects.toThrow();
  await flushRetiredCredentialTelemetry();
  expect(f.store.getSnapshot().status).toBe("locked");
  expect(retiredCredentialStatus(owner.tomb).events).toHaveLength(1);
  expect(retiredCredentialStatus(owner.tomb).events[0]).toMatchObject({
    type: "retired_credential_observed",
    response: "reject",
  });
});
