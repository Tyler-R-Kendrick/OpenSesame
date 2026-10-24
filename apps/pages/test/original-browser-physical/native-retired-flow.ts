import {
  readDeviceRows,
  readDeviceSecrets,
  writeDeviceRows,
  writeDeviceSecrets,
} from "@opensesame/app-core/lib/device-connector-records.js";
import { listDeviceConnections } from "@opensesame/app-core/lib/device-connectors.js";
/** Full local lifecycle against original native storage and real owner/retired crypto. */
import { kvFlush } from "@opensesame/app-core/lib/kv.js";
import { createLocalVaultBackend } from "@opensesame/app-core/lib/secret-backends/local.js";
import { secretBackendDraft } from "@opensesame/app-core/lib/secret-backends/presets.js";
import {
  VaultStore,
  vaultStore,
} from "@opensesame/app-core/lib/vault/store.js";
import {
  type VaultItem,
  createItem,
  parseTotp,
  totpCode,
} from "@opensesame/vault-core";
import type {
  LocalRetiredInspection,
  LocalVaultStarted,
} from "@opensesame/vault-core/local-vault-security.js";
import { check, raw, ready, refuses, result } from "./native-fixture.js";
const PASSWORD = "actual browser retired lifecycle genuine owner password";
function complete(started: LocalVaultStarted<LocalRetiredInspection>) {
  if (started.kind !== "complete")
    throw new Error("Unexpected configured factor in ordinary owner fixture.");
  return started.result;
}
export async function retiredLifecycle() {
  await ready();
  const store = vaultStore;
  try {
    await store.create(PASSWORD);
    const ownerItem = createItem("note", "Genuine owner private note");
    ownerItem.notes = "must never enter synthetic vault";
    await store.saveItem(ownerItem);
    await enrollRecords(store);
    const originalCiphertext = await physicalOwner();
    const scratchId = await exerciseRealms(
      store,
      ownerItem,
      originalCiphertext,
    );
    await verifyOwner(store, ownerItem.id, scratchId);
  } finally {
    store.lock();
    await kvFlush();
  }
  return result();
}

async function enrollRecords(store: VaultStore) {
  const primary = { kind: "password" as const, secret: PASSWORD };
  const initial = complete(
    await store.beginRetired(primary, { kind: "inspect" }),
  );
  check(
    initial.traps.length === 0,
    "fresh primary inspects actual empty retired inventory",
  );
  await refuses(() =>
    store.beginRetired(
      { kind: "password", secret: "incorrect current key" },
      { kind: "inspect" },
    ),
  );
  await refuses(() =>
    store.beginRetired(primary, {
      kind: "change",
      change: { type: "enroll", password: PASSWORD, response: "reject" },
    }),
  );
  check(true, "wrong primary and current credential enrollment both refuse");
  const rejected = "actual browser retired rejected password";
  const synthetic = "actual browser retired synthetic password";
  complete(
    await store.beginRetired(primary, {
      kind: "change",
      change: { type: "enroll", password: rejected, response: "reject" },
    }),
  );
  const enrolled = complete(
    await store.beginRetired(primary, {
      kind: "change",
      change: {
        type: "enroll",
        password: synthetic,
        response: "synthetic_decoy",
        retentionMs: 86400000,
      },
    }),
  );
  check(
    enrolled.traps.length === 2,
    "actual native records enroll reject and synthetic responses",
  );
}

async function exerciseRealms(
  store: VaultStore,
  ownerItem: VaultItem,
  originalCiphertext: string,
) {
  const rejected = "actual browser retired rejected password";
  const synthetic = "actual browser retired synthetic password";
  const rejectBackend = await captureOwnerBackend(store);
  seedOwnerConnector();
  await kvFlush();
  store.lock();
  await refuses(() => store.unlock(rejected));
  check(
    store.getSnapshot().status === "locked" && !store.isGenuineSession(),
    "retired reject leaves original locked without owner authority",
  );
  await store.unlock(synthetic);
  check(
    store.getSnapshot().guest &&
      store.getSnapshot().decoy &&
      !store.isGenuineSession(),
    "retired synthetic password selects only scratch realm",
  );
  check(
    !store
      .getSnapshot()
      .items.some(
        (item) => item.id === ownerItem.id || item.notes === ownerItem.notes,
      ),
    "synthetic realm contains no genuine owner item",
  );
  check(
    readDeviceRows().length === 0 &&
      Object.keys(readDeviceSecrets()).length === 0 &&
      listDeviceConnections().length === 0,
    "synthetic public connector facade hides original metadata and credentials",
  );
  await rejectBackend();
  check(
    true,
    "synthetic realm cannot adopt a captured or new owner secret backend",
  );
  const scratch = createItem("note", "Synthetic scratch note");
  await store.saveItem(scratch);
  check(
    store.getSnapshot().items.some((item) => item.id === scratch.id),
    "synthetic writes stay in scratch realm",
  );
  await refuses(async () => store.exportSealed());
  check(true, "synthetic realm cannot export genuine sealed vault");
  store.lock();
  check(
    store.getSnapshot().status === "locked",
    "synthetic exit returns to locked state",
  );

  check(
    readDeviceRows().some(
      (row) => row.connectionId === "conn_local_retired-proof",
    ) &&
      readDeviceSecrets()["conn_local_retired-proof"]?.token ===
        "original private credential",
    "synthetic exit preserves original connector ledger for locked owner",
  );
  check(
    (await physicalOwner()) === originalCiphertext,
    "synthetic interaction preserves original physical sealed bytes",
  );
  return scratch.id;
}

async function verifyOwner(
  store: VaultStore,
  ownerId: string,
  scratchId: string,
) {
  const primary = { kind: "password" as const, secret: PASSWORD };
  await store.unlock(PASSWORD);
  check(
    store.isGenuineSession(),
    "fresh genuine password restores genuine owner realm",
  );
  check(
    store.getSnapshot().items.some((item) => item.id === ownerId) &&
      !store.getSnapshot().items.some((item) => item.id === scratchId),
    "genuine owner data preserved and scratch write absent",
  );
  const observed = complete(
    await store.beginRetired(primary, { kind: "inspect" }),
  );
  check(
    observed.events.filter(
      (event) => event.type === "retired_credential_observed",
    ).length === 2,
    "both retired logins recorded in actual native owner inventory",
  );
  complete(
    await store.beginRetired(primary, {
      kind: "change",
      change: { type: "clear-events" },
    }),
  );
  const id = observed.traps[0]?.id;
  if (!id) throw new Error("Missing original enrolled trap.");
  const removed = complete(
    await store.beginRetired(primary, {
      kind: "change",
      change: { type: "remove", id },
    }),
  );
  check(
    removed.traps.length === 1 && removed.events.length === 0,
    "fresh management clears events and removes a record durably",
  );
}

async function physicalOwner() {
  return JSON.stringify([
    await raw("tomb/personal/header"),
    await raw("tomb/personal/body"),
  ]);
}

export async function retiredFactorLifecycle() {
  await ready();
  const store = new VaultStore();
  try {
    await store.create(PASSWORD);
    const uri = await store.beginTotpEnrollment();
    const config = parseTotp(uri);
    const enrollmentCode = await totpCode(config);
    await store.confirmTotpEnrollment(enrollmentCode);
    const primary = { kind: "password" as const, secret: PASSWORD };
    const started = await store.beginRetired(primary, { kind: "inspect" });
    if (started.kind !== "challenge")
      throw new Error("Actual configured TOTP was bypassed.");
    check(
      started.routes.includes("totp"),
      "native configured TOTP challenges fresh retired management",
    );
    const valid = await totpCode(config);
    const incorrect = valid === "000000" ? "000001" : "000000";
    await refuses(() => started.complete({ kind: "totp", code: incorrect }));
    check(true, "incorrect genuine TOTP cannot inspect native retired records");
    const fresh = await store.beginRetired(primary, { kind: "inspect" });
    if (fresh.kind !== "challenge")
      throw new Error("Fresh configured TOTP challenge absent.");
    const inspected = await fresh.complete({
      kind: "totp",
      code: await totpCode(config),
    });
    check(
      inspected.traps.length === 0,
      "fresh primary plus actual configured TOTP admits bounded native inspection",
    );
  } finally {
    store.lock();
    await kvFlush();
  }
  return result();
}

async function captureOwnerBackend(store: VaultStore) {
  const backend = createLocalVaultBackend(store);
  const draft = secretBackendDraft("byo-secret-backend");
  const session = await backend.authenticate(draft);
  await backend.listItems(session);
  return async () => {
    await refuses(() => backend.listItems(session));
    await refuses(() => backend.authenticate(draft));
  };
}

function seedOwnerConnector() {
  writeDeviceRows([
    {
      connectionId: "conn_local_retired-proof",
      providerId: "linear",
      displayName: "Genuine private provider",
      scopes: ["private-owner-scope"],
      fields: {},
      createdAt: "2026-10-18T00:00:00Z",
      updatedAt: "2026-10-18T00:00:00Z",
    },
  ]);
  writeDeviceSecrets({
    "conn_local_retired-proof": { token: "original private credential" },
  });
  check(
    listDeviceConnections().some(
      (row) => row.displayName === "Genuine private provider",
    ),
    "genuine provider contribution exposes original configured metadata",
  );
}
