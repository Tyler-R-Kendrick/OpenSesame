import { afterEach, describe, expect, it } from "vitest";
import {
  type IdpRecord,
  ceremonyDismissed,
  dismissIdpCeremony,
  idpCeremonyNeeded,
  idpRegistrySeams,
  listIdpRegistrations,
  registerIdp,
  removeIdpRegistration,
} from "./idp-registry.js";

type RegistrySlot = { raw: string | null };
const store: RegistrySlot = { raw: null };
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
});
