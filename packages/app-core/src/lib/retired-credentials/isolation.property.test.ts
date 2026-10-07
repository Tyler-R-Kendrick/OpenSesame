import {
  createItem,
  createVault,
  importVaultKey,
  openJson,
  rewrapVaultKey,
  sealJson,
  unwrapRawVaultKeyFromPassword,
  vaultSealBinding,
} from "@opensesame/vault-core";
import fc from "fast-check";
import { afterEach, beforeEach, expect, it } from "vitest";
import { markDecoySession } from "../decoy-session.js";
import {
  clearActivePresentation,
  readActivePresentation,
} from "../duress/compartment/presentation-runtime.js";
import { duressSessionFence } from "../duress/session/fence.js";
import { kvGet } from "../kv.js";
import { VaultStore } from "../vault/store.js";
import { BODY_PATH, HEADER_PATH, tombFileKey } from "../vfs.js";
import { probeRetiredCredential } from "./index.js";
import { openRetiredCredentialDecoy } from "./session.js";
import { PASSWORD, createRetiredCredentialFixture } from "./test-support.js";

let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
let otherOwner: VaultStore | null = null;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
});
afterEach(() => {
  otherOwner?.lock();
  otherOwner = null;
  fixture.restore();
  clearActivePresentation();
});

it("keeps an already-open owner's data and encrypted files intact after stale credential use", async () => {
  const ownerItem = createItem("note", "Owner private information");
  ownerItem.notes = "never-admitted-real-secret";
  await fixture.store.saveItem(ownerItem);
  await fixture.store.flushPendingWrites();
  await fixture.enroll("stale-autofill", "reject");
  const state = fixture.store.getSnapshot();
  const files = [HEADER_PATH, BODY_PATH].map((path) =>
    kvGet(tombFileKey("personal", path)),
  );
  const fence = duressSessionFence.readFence();
  await expect(
    probeRetiredCredential("stale-autofill", "personal"),
  ).resolves.toMatchObject({ response: "reject" });
  expect(fixture.store.getSnapshot()).toEqual(state);
  expect(
    [HEADER_PATH, BODY_PATH].map((path) =>
      kvGet(tombFileKey("personal", path)),
    ),
  ).toEqual(files);
  expect(duressSessionFence.readFence()).toEqual(fence);
});

it("fails real-ciphertext decryption even after presentation labels and the local guard are removed", async () => {
  const ownerItem = createItem("note", "Private owner account");
  ownerItem.notes = "owner-exclusive-material";
  await fixture.store.saveItem(ownerItem);
  const real = await fixture.store.sealedSnapshot();
  fixture.store.lock();
  otherOwner = new VaultStore();
  await otherOwner.unlock(PASSWORD);
  const files = [HEADER_PATH, BODY_PATH].map((path) =>
    kvGet(tombFileKey("personal", path)),
  );
  await openRetiredCredentialDecoy(
    fixture.store,
    {
      id: "known-retired-trap",
      response: "synthetic_decoy",
      createdAt: new Date().toISOString(),
    },
    "personal",
  );
  const presentation = readActivePresentation();
  if (!presentation || presentation.outcome.kind !== "opened")
    throw new Error("Missing admitted decoy keys");
  const admitted = presentation.outcome.session.admitted;
  expect(admitted).toHaveLength(1);
  expect(fixture.store.getSnapshot().items).not.toContainEqual(
    expect.objectContaining({ id: ownerItem.id }),
  );
  expect(otherOwner.getSnapshot()).toMatchObject({
    status: "locked",
    header: null,
    items: [],
  });
  const syntheticHeader = fixture.store.getSnapshot().header;
  if (!syntheticHeader) throw new Error("Missing independent scratch header");
  clearActivePresentation();
  markDecoySession(false);
  for (const key of admitted) {
    expect(key.cryptoKey.extractable).toBe(false);
    await expect(
      openJson(
        key.cryptoKey,
        real.body,
        vaultSealBinding(real.tomb, BODY_PATH),
      ),
    ).rejects.toThrow(/authentication tag/);
  }
  // Direct production snapshot merge remains gated even after presentation ends.
  // Independent-key AEAD failure was tested above without relying on that gate.
  await expect(
    fixture.store.mergeSnapshot({
      tomb: real.tomb,
      // Make the attacker's snapshot metadata pass the earlier vault-identity
      // check, so this assertion reaches decryption with the scratch root.
      createdAt: syntheticHeader.createdAt,
      body: real.body,
      rev: real.rev,
    }),
  ).rejects.toThrow(/authenticate again/);
  expect(
    [HEADER_PATH, BODY_PATH].map((path) =>
      kvGet(tombFileKey("personal", path)),
    ),
  ).toEqual(files);
});

it("authenticates ciphertext scope under adversarial destination substitutions", async () => {
  const owner = await createVault("current-password-for-scope-proof");
  try {
    const body = await sealJson(
      owner.vaultKey,
      { secret: "real-only" },
      vaultSealBinding("personal", BODY_PATH),
    );
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 1, maxLength: 80 })
          .filter((scope) => scope !== "personal"),
        async (scope) => {
          await expect(
            openJson(owner.vaultKey, body, vaultSealBinding(scope, BODY_PATH)),
          ).rejects.toThrow(/authentication tag/);
        },
      ),
      { seed: 1730107, numRuns: 32 },
    );
    await expect(
      openJson(owner.vaultKey, body, vaultSealBinding("personal", BODY_PATH)),
    ).resolves.toEqual({ secret: "real-only" });
  } finally {
    owner.rawVaultKey.fill(0);
  }
});

it("documents the residual: an old wrapped snapshot still recovers a reused root after password rewrapping", async () => {
  const original = await createVault("formerly-valid-password");
  let recovered: Uint8Array | null = null;
  try {
    const newHeader = await rewrapVaultKey(
      original.header,
      "formerly-valid-password",
      "replacement-password",
    );
    await expect(
      unwrapRawVaultKeyFromPassword(newHeader, "formerly-valid-password"),
    ).rejects.toThrow();
    recovered = await unwrapRawVaultKeyFromPassword(
      original.header,
      "formerly-valid-password",
    );
    const body = await sealJson(original.vaultKey, {
      secret: "new-body-same-root",
    });
    await expect(
      openJson(await importVaultKey(recovered), body),
    ).resolves.toEqual({ secret: "new-body-same-root" });
  } finally {
    recovered?.fill(0);
    original.rawVaultKey.fill(0);
  }
});
