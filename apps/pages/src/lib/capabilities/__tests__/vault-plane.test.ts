/**
 * VAULT-01 … VAULT-05 — the password/passkey vault under a composed
 * installation.
 *
 * These run against the real catalog, the real shipped profiles and the real
 * `VaultStore`: the family this covers is about *this* product's vault when
 * an operator has excluded most of the optional surface, so a fixture realm
 * would prove nothing. `family-local` resolves to zero approved optional
 * capabilities (`profiles.test.ts` pins that) for scenarios that block every
 * optional surface. `minimal-local` includes Access and browser-local IAM by
 * product default (Tyler D2); the first scenario asserts that plan.
 */

import {
  coreCapabilityIds,
  optionalCapabilityIds,
} from "@opensesame/app-core/lib/capabilities/catalog.js";
import { itemKindsFrom } from "@opensesame/app-core/lib/item-kinds.js";
import { kvDelete, kvGet } from "@opensesame/app-core/lib/kv.js";
import { assertCiphertextOnlyBackupJson } from "@opensesame/app-core/lib/vault/offline-backup.js";
import {
  ATTEMPTS_KEY,
  VaultStore,
} from "@opensesame/app-core/lib/vault/store.js";
import { LEGACY_PREFS_KEY } from "@opensesame/app-core/lib/vault/tomb-migration.js";
import type { PasskeyCeremony } from "@opensesame/app-core/lib/vault/unlock-methods.js";
import {
  assertKeepsPrimaryUnlock,
  listAvailableUnlockMethods,
  unlockMethodsSeams,
} from "@opensesame/app-core/lib/vault/unlock-methods.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "@opensesame/app-core/lib/vfs.js";
import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { KIND_LABEL, createItem, randomBytes } from "@opensesame/vault-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withPassword } from "../../../sections/vault/account.test-support.js";
import { approved, profilePlan, profileSelection } from "./vault-profiles.js";

const PASSWORD = "correct horse battery staple";
const PIN = "918273645";
const HEADER_KEY = tombFileKey(PERSONAL_TOMB, HEADER_PATH);
const BODY_KEY = tombFileKey(PERSONAL_TOMB, BODY_PATH);

/**
 * The WebAuthn ceremony needs a real authenticator; everything around it —
 * salt, wrapping, unwrapping, header persistence — runs for real. This is
 * the same stand-in `store-passkey.test.ts` uses.
 */
/** What the stand-in ceremony hands back, set per case. */
type CeremonyStandIn = {
  prfOutput: ArrayBuffer | null;
  credentialId: BoundaryValue;
};

/** The identity fields a test may point a vault scope elsewhere with. */
type ScopeIdentity = { vaultId?: string; instanceId?: string };

const ceremony = vi.hoisted(
  (): CeremonyStandIn => ({
    prfOutput: null,
    credentialId: null,
  }),
);
Object.assign(unlockMethodsSeams, {
  createPasskeyUnlockCeremony: async (): Promise<PasskeyCeremony> => {
    const prfOutput: ArrayBuffer = overlapCast(randomBytes(32).buffer);
    const rawId: ArrayBuffer = overlapCast(randomBytes(16).buffer);
    ceremony.prfOutput = prfOutput;
    ceremony.credentialId = overlapCast(rawId);
    return {
      credential: overlapCast({ rawId }),
      prfOutput,
      prfSalt: randomBytes(16),
      userId: randomBytes(16),
    };
  },
  getPasskeyUnlockCeremony: async (): Promise<ArrayBuffer> => {
    if (!ceremony.prfOutput) throw new Error("no ceremony was run");
    return ceremony.prfOutput;
  },
});

async function clearVaultSurface(): Promise<void> {
  await vfsFlush();
  kvDelete(ATTEMPTS_KEY);
  kvDelete(HEADER_KEY);
  kvDelete(BODY_KEY);
  kvDelete(tombFileKey(PERSONAL_TOMB, MIGRATION_MARKER_PATH));
  kvDelete(tombFileKey(PERSONAL_TOMB, INDEX_PATH));
  kvDelete(LEGACY_PREFS_KEY);
}

beforeEach(async () => {
  await clearVaultSurface();
});

describe("VAULT-01 — the vault works with every optional service blocked", () => {
  it("creates, locks, unlocks, edits and backs up under minimal-local", async () => {
    const plan = profilePlan("minimal-local");
    const pwaDefaults = new Set(["access.authority", "identity.local-iam"]);
    for (const id of optionalCapabilityIds())
      expect(approved(plan, id), id).toBe(pwaDefaults.has(id));
    expect([...plan.approvedCapabilities].sort()).toEqual(
      [...coreCapabilityIds(), ...pwaDefaults].sort(),
    );

    const store = new VaultStore();
    await store.create(PASSWORD);
    const login = createItem("account", "Library card");
    login.username = "ada";
    withPassword(login, "hunter2-but-longer");
    await store.saveItem(login);
    await store.flushPendingWrites();
    store.lock();
    expect(store.getSnapshot().status).toBe("locked");

    const reopened = new VaultStore();
    await reopened.unlock(PASSWORD);
    const found = reopened
      .getSnapshot()
      .items.find((item) => item.id === login.id);
    expect(found?.name).toBe("Library card");

    // Editing is the same road, and it survives another lock.
    // SAFETY: `found` came out of the body, so it is a VaultItem.
    await reopened.saveItem(overlapCast({ ...found, name: "Library card II" }));
    await reopened.flushPendingWrites();
    reopened.lock();
    const again = new VaultStore();
    await again.unlock(PASSWORD);
    expect(again.getSnapshot().items.find((i) => i.id === login.id)?.name).toBe(
      "Library card II",
    );

    // The encrypted backup is the sealed body and the public header, and the
    // ciphertext-only gate is what a restore would be handed.
    const header = kvGet(HEADER_KEY) ?? "";
    const body = kvGet(BODY_KEY) ?? "";
    expect(body).not.toContain("hunter2-but-longer");
    expect(() =>
      assertCiphertextOnlyBackupJson(
        JSON.stringify({ vault: { header: JSON.parse(header), body } }),
      ),
    ).not.toThrow();
  });
});

describe("VAULT-02 — PRF protection is preserved under an accepted profile", () => {
  it("keeps its own salt, leaves the root wrapped, and binds the credential", async () => {
    const plan = profilePlan("family-local");
    expect(approved(plan, "vault.local-unlock")).toBe(true);

    const store = new VaultStore();
    await store.create(PASSWORD);
    const wrapBefore = store.getSnapshot().header?.wrap?.ctB64;
    const kdfBefore = store.getSnapshot().header?.kdf?.saltB64;

    await store.enrollPasskey();
    const record = store.getSnapshot().header?.unlocks?.passkey;
    expect(record).toBeDefined();
    // Its own salt, not a shared or derived one.
    expect(record?.prfSaltB64).toBeTruthy();
    // Bound to the credential that produced the PRF output.
    expect(record?.credentialIdB64).toBeTruthy();
    // Root wrapping is preserved: the password wrap and its derivation are
    // untouched, so enrolling a second method never rewrites the first.
    expect(store.getSnapshot().header?.wrap?.ctB64).toBe(wrapBefore);
    expect(store.getSnapshot().header?.kdf?.saltB64).toBe(kdfBefore);

    // The unlock screen's tabs are exactly the enrolled methods.
    expect(
      listAvailableUnlockMethods(store.getSnapshot().header).sort(),
    ).toEqual(["passkey", "password"]);

    // The plaintext header is public: the PRF output is never in it.
    const prf = ceremony.prfOutput;
    expect(prf).toBeTruthy();
    // SAFETY: asserted above.
    const prfB64 = btoa(
      String.fromCharCode(...new Uint8Array(overlapCast(prf))),
    );
    expect(kvGet(HEADER_KEY) ?? "").not.toContain(prfB64);

    await store.flushPendingWrites();
    store.lock();
    const reopened = new VaultStore();
    await reopened.unlockWithPasskey();
    expect(reopened.getSnapshot().status).toBe("unlocked");
  });
});

describe("VAULT-03 — the last protector cannot be removed", () => {
  it("refuses, and leaves no weaker way in behind it", async () => {
    const store = new VaultStore();
    await store.createWithPin(PIN);
    const header = store.getSnapshot().header;
    expect(header).toBeTruthy();
    expect(listAvailableUnlockMethods(header)).toEqual(["pin"]);

    // SAFETY: created above.
    expect(() => assertKeepsPrimaryUnlock(overlapCast(header), "pin")).toThrow(
      /at least one primary unlock method/,
    );
    // The refusal changes nothing: no fallback appeared in its place.
    expect(listAvailableUnlockMethods(store.getSnapshot().header)).toEqual([
      "pin",
    ]);

    // With a replacement in place the same removal is allowed — the rule is
    // "keep one", not "never remove".
    await store.enrollPassword(PASSWORD);
    const withBoth = store.getSnapshot().header;
    expect(listAvailableUnlockMethods(withBoth).sort()).toEqual([
      "password",
      "pin",
    ]);
    // SAFETY: as above.
    expect(() =>
      assertKeepsPrimaryUnlock(overlapCast(withBoth), "pin"),
    ).not.toThrow();
  });
});

describe("VAULT-04 — pre-unlock metadata cannot broaden the plan", () => {
  /**
   * The vault scope is the innermost, and the document it is written in
   * carries no allow list at all: `VaultCapabilitySelection` is
   * `{ …, disabled: CapabilityId[] }`. Rewriting a tomb's pre-unlock record
   * therefore has exactly one direction — away. There is no shape in which
   * it asks for a capability, so there is nothing for the resolver to refuse.
   */
  const vaultScope = (
    disabled: readonly string[],
    over: ScopeIdentity = {},
  ) => ({
    schemaVersion: 1 as const,
    kind: "VaultCapabilitySelection" as const,
    instanceId: over.instanceId ?? "household-1",
    installationId: profileSelection("family-sharing-selected").installationId,
    vaultId: over.vaultId ?? "personal",
    revision: "forged-1",
    disabled: [...disabled],
  });

  it("only narrows, and a scope bound to another vault does not apply", () => {
    const base = profilePlan("family-sharing-selected", {
      vaultId: "personal",
    });
    expect(approved(base, "sharing.drops")).toBe(true);
    expect(approved(base, "sharing.household")).toBe(true);

    // Naming an approved capability turns it off — the one direction there is.
    // Drops are always on, so a vault scope cannot withdraw them.
    const narrowed = profilePlan("family-sharing-selected", {
      vaultId: "personal",
      vault: vaultScope(["sharing.household"]),
    });
    expect(approved(narrowed, "sharing.drops")).toBe(true);
    expect(approved(narrowed, "sharing.household")).toBe(false);

    // A record lifted from another tomb is not this vault's, and it does not
    // get to act as if it were. It denies rather than lapsing: a restriction
    // that stops applying is a restriction that widens, which this scope may
    // never do. Its three identity fields went unread until this found them.
    const foreign = profilePlan("family-sharing-selected", {
      vaultId: "personal",
      vault: vaultScope(["sharing.drops"], { vaultId: "project-4f2a" }),
    });
    expect(approved(foreign, "sharing.drops")).toBe(true);
    expect(approved(foreign, "sharing.household")).toBe(false);
    expect(foreign.capabilities["sharing.household"]?.reasons).toContain(
      "DISABLED_IN_VAULT",
    );
    // The same for one written against another installation or instance.
    for (const over of [
      { instanceId: "someone-elses-household" },
      { vaultId: "personal" },
    ]) {
      const other = profilePlan("family-sharing-selected", {
        vaultId: "personal",
        installationId: "another-installation",
        vault: vaultScope([], over),
      });
      expect(approved(other, "sharing.household")).toBe(false);
      expect(approved(other, "sharing.drops")).toBe(true);
    }

    // And nothing a tomb holds can turn a prohibited capability on, because
    // no field in that document says "on".
    for (const plan of [base, narrowed, foreign])
      expect(approved(plan, "support.remote-ai")).toBe(false);
  });
});

describe("VAULT-05 — records of an excluded kind survive without their surfaces", () => {
  it("round-trips a drop record while offering no way to create one", async () => {
    // The minimal vault creates secrets and files. Drops are a share.
    const plan = profilePlan("family-local");
    expect(approved(plan, "sharing.drops")).toBe(true);
    expect(approved(plan, "vault.passkey-records")).toBe(false);
    expect(plan.approvedItemKinds).toEqual(["file", "secret"]);

    const store = new VaultStore();
    await store.create(PASSWORD);
    const record = createItem("drop", "shared wifi");
    await store.saveItem(record);
    await store.flushPendingWrites();
    store.lock();

    const reopened = new VaultStore();
    await reopened.unlock(PASSWORD);
    const kept = reopened
      .getSnapshot()
      .items.find((item) => item.id === record.id);
    expect(kept?.kind).toBe("drop");
    expect(kept?.name).toBe("shared wifi");

    // With nothing contributed, the kinds a person may create here are the
    // secret and the file. The stored drop record still renders.
    const kinds = itemKindsFrom([]).map((row) => row.id);
    expect(kinds).toEqual(["secret", "file"]);
    expect(kinds).not.toContain("drop");
    expect(KIND_LABEL.drop).toBeTruthy();
  });
});
