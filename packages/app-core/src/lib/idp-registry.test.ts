import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEVICE_IDP_ID,
  IDP_REGISTRY_CONFIG_PATH,
  type IdpRecord,
  ceremonyDismissed,
  deviceIdpRecord,
  discardIdpRegistry,
  dismissIdpCeremony,
  hydrateIdpRegistryFromVfs,
  idpCeremonyNeeded,
  idpRegistrySeams,
  listAdditionalIdpRegistrations,
  listIdpRegistrations,
  registerIdp,
  removeIdpRegistration,
} from "./idp-registry.js";
import { kvDelete, kvGet } from "./kv.js";
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

function withDevice(...additional: IdpRecord[]): IdpRecord[] {
  return [deviceIdpRecord(), ...additional];
}

describe("idp registry", () => {
  afterEach(() => {
    store.raw = null;
  });

  it("always lists the device IdP when nothing additional is stored", () => {
    expect(listIdpRegistrations()).toEqual(withDevice());
    expect(listAdditionalIdpRegistrations()).toEqual([]);
    expect(ceremonyDismissed()).toBe(false);
    expect(idpCeremonyNeeded()).toBe(false);
  });

  it("treats malformed stored JSON as no additional upstreams", () => {
    store.raw = "{not json";
    expect(listIdpRegistrations()).toEqual(withDevice());
    expect(idpCeremonyNeeded()).toBe(false);

    store.raw = JSON.stringify({ providers: "nope", ceremonyDismissed: 1 });
    expect(listIdpRegistrations()).toEqual(withDevice());
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
    expect(listIdpRegistrations()).toEqual(withDevice(makeRecord()));
  });

  it("never gates on missing additional upstreams — the device IdP vouches", () => {
    expect(idpCeremonyNeeded()).toBe(false);
    registerIdp(makeRecord());
    expect(idpCeremonyNeeded()).toBe(false);
    expect(listIdpRegistrations()).toEqual(withDevice(makeRecord()));
  });

  it("upserts by id instead of listing a provider twice", () => {
    registerIdp(makeRecord());
    registerIdp(makeRecord({ label: "Google Workspace" }));
    expect(listIdpRegistrations()).toEqual(
      withDevice(makeRecord({ label: "Google Workspace" })),
    );
  });

  it("keeps the dismissal flag across registrations", () => {
    dismissIdpCeremony();
    registerIdp(makeRecord());
    expect(ceremonyDismissed()).toBe(true);
    expect(idpCeremonyNeeded()).toBe(false);
  });

  it("dismisses without clearing the device IdP", () => {
    dismissIdpCeremony();
    expect(ceremonyDismissed()).toBe(true);
    expect(idpCeremonyNeeded()).toBe(false);
    expect(listIdpRegistrations()).toEqual(withDevice());
  });

  it("removes only the local mirror of an additional binding", () => {
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
    expect(listIdpRegistrations()).toHaveLength(3);

    removeIdpRegistration("google");
    expect(listIdpRegistrations()).toEqual(
      withDevice(
        makeRecord({
          id: "byo:https://auth.example.dev",
          issuer: "https://auth.example.dev",
          label: "Example IdP",
          kind: "byo",
          clientId: "cli_1",
          clientAuth: "client_secret_basic",
          redirectUri: "http://127.0.0.1:8788/v1/federated/callback",
        }),
      ),
    );

    removeIdpRegistration("byo:https://auth.example.dev");
    expect(listIdpRegistrations()).toEqual(withDevice());
  });

  it("refuses to remove the device IdP", () => {
    registerIdp(makeRecord());
    expect(removeIdpRegistration(DEVICE_IDP_ID)).toEqual(
      withDevice(makeRecord()),
    );
    expect(listIdpRegistrations()).toEqual(withDevice(makeRecord()));
  });

  it("never re-gates when the last additional binding is removed", () => {
    dismissIdpCeremony();
    registerIdp(makeRecord());
    removeIdpRegistration("google");
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
    expect(listIdpRegistrations()).toEqual(withDevice(byo));
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
    expect(listIdpRegistrations()).toEqual(withDevice(okta));
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
    expect(listIdpRegistrations()).toEqual(withDevice(makeRecord()));
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

  it("still lists the device IdP while locked (synthetic, not sealed)", async () => {
    useVfsBackedSeams();
    await unlockedPersonalTomb();
    await writeFile(
      PERSONAL_TOMB,
      IDP_REGISTRY_CONFIG_PATH,
      new TextEncoder().encode(
        JSON.stringify({ version: 1, providers: [makeRecord()] }),
      ),
    );

    // Locked: no key, no hydrated cache — additional upstreams empty.
    lockAllTombs();
    discardIdpRegistry();
    expect(listIdpRegistrations()).toEqual(withDevice());
    expect(idpCeremonyNeeded()).toBe(false);
  });

  it("hydrates from the sealed config and keeps no plaintext at rest", async () => {
    useVfsBackedSeams();
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    await hydrateIdpRegistryFromVfs(PERSONAL_TOMB);
    expect(listIdpRegistrations()).toEqual(withDevice());

    registerIdp(makeRecord());
    await vfsFlush();
    expect(listIdpRegistrations()).toEqual(withDevice(makeRecord()));

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
    expect(listIdpRegistrations()).toEqual(withDevice(makeRecord()));
    expect(idpCeremonyNeeded()).toBe(false);
  });

  it("treats a missing file as only the device IdP", async () => {
    useVfsBackedSeams();
    await unlockedPersonalTomb();
    await hydrateIdpRegistryFromVfs(PERSONAL_TOMB);
    expect(listIdpRegistrations()).toEqual(withDevice());
    expect(ceremonyDismissed()).toBe(false);
  });
});
