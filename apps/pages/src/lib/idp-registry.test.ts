import { afterEach, describe, expect, it } from "vitest";
import {
  IDP_REGISTRY_CONFIG_PATH,
  type IdpRecord,
  ceremonyDismissed,
  discardIdpRegistry,
  dismissIdpCeremony,
  hydrateIdpRegistryFromVfs,
  idpCeremonyNeeded,
  idpRegistrySeams,
  listIdpRegistrations,
  registerIdp,
  removeIdpRegistration,
} from "./idp-registry.js";
import { kvDelete, kvGet } from "./kv.js";
import { mintVaultKey } from "./vault/crypto.js";
import {
  PERSONAL_TOMB,
  TOMBS_REGISTRY_KEY,
  lockAllTombs,
  tombFileKey,
  unlockTomb,
  vfsFlush,
  writeFile,
} from "./vfs.js";

type RegistrySlot = { raw: string | null };
const store: RegistrySlot = { raw: null };
// The default (VFS-backed) seams, saved before the slot override below so the
// VFS suite at the bottom can put them back.
const vfsBackedSeams = { ...idpRegistrySeams };
Object.assign(idpRegistrySeams, {
  read: () => store.raw,
  write: (raw: string) => {
    store.raw = raw;
  },
  clear: () => {
    store.raw = null;
  },
});

function makeRecord(overrides: Partial<IdpRecord> = {}): IdpRecord {
  return {
    id: "google",
    issuer: "http://127.0.0.1:8788",
    label: "Google",
    kind: "first-class",
    registeredAt: "2026-08-29T10:00:00Z",
    ...overrides,
  };
}

describe("idp registry", () => {
  afterEach(() => {
    store.raw = null;
  });

  it("reads empty when nothing is stored, so the ceremony shows", () => {
    expect(listIdpRegistrations()).toEqual([]);
    expect(ceremonyDismissed()).toBe(false);
    expect(idpCeremonyNeeded()).toBe(true);
  });

  it("treats malformed stored JSON as empty", () => {
    store.raw = "{not json";
    expect(listIdpRegistrations()).toEqual([]);
    expect(idpCeremonyNeeded()).toBe(true);

    store.raw = JSON.stringify({ providers: "nope", ceremonyDismissed: 1 });
    expect(listIdpRegistrations()).toEqual([]);
    expect(ceremonyDismissed()).toBe(false);
  });

  it("drops stored records that are not the contract", () => {
    store.raw = JSON.stringify({
      version: 1,
      providers: [
        makeRecord(),
        { id: "", issuer: "x" },
        { id: "ok", issuer: 42 },
      ],
      ceremonyDismissed: false,
    });
    expect(listIdpRegistrations()).toEqual([makeRecord()]);
  });

  it("lifts the gate once a provider is registered", () => {
    expect(idpCeremonyNeeded()).toBe(true);
    registerIdp(makeRecord());
    expect(idpCeremonyNeeded()).toBe(false);
    expect(listIdpRegistrations()).toEqual([makeRecord()]);
  });

  it("upserts by id instead of listing a provider twice", () => {
    registerIdp(makeRecord());
    registerIdp(makeRecord({ label: "Google Workspace" }));
    expect(listIdpRegistrations()).toEqual([
      makeRecord({ label: "Google Workspace" }),
    ]);
  });

  it("keeps the dismissal flag across registrations", () => {
    dismissIdpCeremony();
    registerIdp(makeRecord());
    expect(ceremonyDismissed()).toBe(true);
    expect(idpCeremonyNeeded()).toBe(false);
  });

  it("lifts the gate on dismiss, with the banner posture behind it", () => {
    dismissIdpCeremony();
    expect(ceremonyDismissed()).toBe(true);
    expect(idpCeremonyNeeded()).toBe(false);
    // The registry is still empty — the Providers tab shows its banner.
    expect(listIdpRegistrations()).toEqual([]);
  });

  it("removes only the local mirror of a binding", () => {
    registerIdp(makeRecord());
    registerIdp(
      makeRecord({
        id: "byo:https://auth.example.dev",
        issuer: "https://auth.example.dev",
        label: "Example IdP",
        kind: "byo",
        clientId: "cli_1",
        clientAuth: "client_secret_basic",
        redirectUri: "http://127.0.0.1:8788/v1/federated/callback",
      }),
    );
    expect(listIdpRegistrations()).toHaveLength(2);

    removeIdpRegistration("google");
    expect(listIdpRegistrations()).toEqual([
      makeRecord({
        id: "byo:https://auth.example.dev",
        issuer: "https://auth.example.dev",
        label: "Example IdP",
        kind: "byo",
        clientId: "cli_1",
        clientAuth: "client_secret_basic",
        redirectUri: "http://127.0.0.1:8788/v1/federated/callback",
      }),
    ]);

    removeIdpRegistration("byo:https://auth.example.dev");
    expect(listIdpRegistrations()).toEqual([]);
  });

  it("re-gates when the last binding is removed and nothing was dismissed", () => {
    dismissIdpCeremony();
    registerIdp(makeRecord());
    removeIdpRegistration("google");
    // The explicit deferral survives removal — the gate stays lifted.
    expect(idpCeremonyNeeded()).toBe(false);
  });

  it("round-trips BYO fields through storage", () => {
    const byo = makeRecord({
      id: "byo:https://auth.example.dev",
      issuer: "https://auth.example.dev",
      label: "Example IdP",
      kind: "byo",
      clientId: "cli_1",
      clientAuth: "none",
      redirectUri: "https://id.example.com/cb",
    });
    registerIdp(byo);
    expect(listIdpRegistrations()).toEqual([byo]);
  });

  it("round-trips the preset providerType through storage", () => {
    const okta = makeRecord({
      id: "byo_2",
      issuer: "https://dev-123456.okta.com",
      label: "Okta",
      kind: "byo",
      providerType: "okta",
      clientId: "cli_2",
      clientAuth: "client_secret_basic",
      redirectUri: "https://id.example.com/cb",
    });
    registerIdp(okta);
    expect(listIdpRegistrations()).toEqual([okta]);
  });

  it("drops stored records whose providerType is off-contract", () => {
    store.raw = JSON.stringify({
      version: 1,
      providers: [
        makeRecord(),
        { ...makeRecord({ id: "byo_3", kind: "byo" }), providerType: "ping" },
        { ...makeRecord({ id: "byo_4", kind: "byo" }), providerType: 42 },
      ],
      ceremonyDismissed: false,
    });
    expect(listIdpRegistrations()).toEqual([makeRecord()]);
  });
});

describe("idp registry through the VFS seam", () => {
  function useVfsBackedSeams(): void {
    Object.assign(idpRegistrySeams, vfsBackedSeams);
    discardIdpRegistry();
    kvDelete(tombFileKey(PERSONAL_TOMB, IDP_REGISTRY_CONFIG_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, "index"));
    kvDelete(TOMBS_REGISTRY_KEY);
  }

  afterEach(async () => {
    await vfsFlush();
    lockAllTombs();
    discardIdpRegistry();
    kvDelete(tombFileKey(PERSONAL_TOMB, IDP_REGISTRY_CONFIG_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, "index"));
    kvDelete(TOMBS_REGISTRY_KEY);
  });

  async function unlockedPersonalTomb(): Promise<void> {
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
  }

  it("is unreadable while locked, even with a sealed file present", async () => {
    useVfsBackedSeams();
    await unlockedPersonalTomb();
    await writeFile(
      PERSONAL_TOMB,
      IDP_REGISTRY_CONFIG_PATH,
      new TextEncoder().encode(
        JSON.stringify({ version: 1, providers: [makeRecord()] }),
      ),
    );

    // Locked: no key, no hydrated cache — the registry answers empty.
    lockAllTombs();
    discardIdpRegistry();
    expect(listIdpRegistrations()).toEqual([]);
    expect(idpCeremonyNeeded()).toBe(true);
  });

  it("hydrates from the sealed config and keeps no plaintext at rest", async () => {
    useVfsBackedSeams();
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    await hydrateIdpRegistryFromVfs(PERSONAL_TOMB);
    expect(listIdpRegistrations()).toEqual([]);

    registerIdp(makeRecord());
    await vfsFlush();
    expect(listIdpRegistrations()).toEqual([makeRecord()]);

    const raw = kvGet(tombFileKey(PERSONAL_TOMB, IDP_REGISTRY_CONFIG_PATH));
    expect(raw).toBeTruthy();
    expect(raw).toContain("ivB64");
    expect(raw).not.toContain("google");
    expect(raw).not.toContain("Google");

    // A fresh session (lock → unlock) unwraps the same vault key and
    // reads the same record back.
    lockAllTombs();
    discardIdpRegistry();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    await hydrateIdpRegistryFromVfs(PERSONAL_TOMB);
    expect(listIdpRegistrations()).toEqual([makeRecord()]);
    expect(idpCeremonyNeeded()).toBe(false);
  });

  it("treats a missing file as the empty registry", async () => {
    useVfsBackedSeams();
    await unlockedPersonalTomb();
    await hydrateIdpRegistryFromVfs(PERSONAL_TOMB);
    expect(listIdpRegistrations()).toEqual([]);
    expect(ceremonyDismissed()).toBe(false);
  });
});
