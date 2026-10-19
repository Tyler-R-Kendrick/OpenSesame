import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createMemoryStorage } from "../memory-storage.js";
import { createTestHost } from "../test-host.js";
import { fenceLocalSignOut } from "./ambient-auth/generation.js";
import { advanceFederationSessionGeneration } from "./federation-native-session.js";
import { identityConnectionDraft } from "./identity-connections-presets.js";
import { writeIdentityConnection } from "./identity-connections-store.js";
import {
  type NativeIdentityOwner,
  captureNativeIdentityOwner,
} from "./identity-native-owner.js";
import { kvFlush, kvForgetAll } from "./kv.js";
import {
  loadSettings,
  saveSettingsDurable,
  signInMethods,
} from "./settings.js";
import { vaultStore } from "./vault/store.js";
import { vfsFlush } from "./vfs.js";

const owners: NativeIdentityOwner[] = [];
beforeEach(async () => {
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await kvFlush();
  vaultStore.lock();
  kvForgetAll();
  configureHost(
    createTestHost({
      storage: { local: createMemoryStorage(), session: createMemoryStorage() },
    }),
  );
  vaultStore.loadActiveProjectScope();
});
afterEach(async () => {
  for (const owner of owners.splice(0)) owner.release();
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await kvFlush();
  vaultStore.lock();
  await vfsFlush();
  await kvFlush();
});
async function configuration(protocol: "saml" | "oidc" = "saml") {
  const draft = {
    ...identityConnectionDraft("byo-identity"),
    protocol,
    issuer: "https://owner.example.test",
    clientSecret:
      protocol === "oidc" ? "public synthetic saved client secret" : "",
    clientId: "urn:owner:sp",
    samlEntityId: "urn:owner:idp",
    samlMetadataXml: "<public-synthetic-owner-config/>",
  };
  const saved = await writeIdentityConnection(draft);
  await saveSettingsDurable({
    ...loadSettings(),
    signIn: {
      ...signInMethods(),
      providers: [
        {
          providerId: draft.providerId,
          protocol,
          label: draft.name,
          connectionId: saved.connectionId,
          issuer: protocol === "saml" ? draft.samlEntityId : draft.issuer,
          clientId: draft.clientId,
        },
      ],
    },
  });
  return { draft, saved };
}
async function owner(protocol: "saml" | "oidc" = "saml") {
  const current = await configuration(protocol);
  const selected = captureNativeIdentityOwner(
    current.saved.connectionId,
    protocol,
  );
  owners.push(selected);
  selected.bindConfiguration(current.draft);
  return { ...current, selected };
}
it("captures the enabled exact saved target without manufacturing protocol identity", async () => {
  const { selected, draft } = await owner();
  expect(() => selected.assertPending()).not.toThrow();
  expect(() =>
    selected.assertSessionCurrent(draft.samlEntityId, draft.clientId),
  ).not.toThrow();
  expect(() =>
    selected.assertSessionCurrent("urn:foreign:idp", draft.clientId),
  ).toThrow("issuer and audience");
  expect(() =>
    selected.assertSessionCurrent(draft.samlEntityId, "urn:foreign:sp"),
  ).toThrow("issuer and audience");
});
it("resaving identical private bytes retires the captured revision permanently", async () => {
  const { selected, draft, saved } = await owner();
  await writeIdentityConnection(draft, saved.connectionId);
  expect(selected.signal.aborted).toBe(true);
  expect(() => selected.assertPending()).toThrow();
});
it("changing private metadata cannot authenticate a later return against its old target", async () => {
  const { selected, draft, saved } = await owner();
  await writeIdentityConnection(
    { ...draft, samlMetadataXml: "<different-owner-config/>" },
    saved.connectionId,
  );
  expect(selected.signal.aborted).toBe(true);
  expect(() =>
    selected.assertSessionCurrent(draft.samlEntityId, draft.clientId),
  ).toThrow();
});
it("editing the public enabled audience retires the captured owner", async () => {
  const { selected } = await owner();
  const settings = loadSettings();
  await saveSettingsDurable({
    ...settings,
    signIn: {
      ...signInMethods(settings),
      providers:
        settings.signIn?.providers.map((provider) => ({
          ...provider,
          clientId: "urn:other:sp",
        })) ?? [],
    },
  });
  expect(selected.signal.aborted).toBe(true);
});
it("sign-out during preparation cannot be adopted by runtime initialization", async () => {
  const { selected } = await owner();
  fenceLocalSignOut();
  const install = vi.fn();
  expect(() => selected.prepareRuntime(install)).toThrow("changed");
  expect(install).not.toHaveBeenCalled();
});
it("canonical federation replacement during preparation cannot be rebased", async () => {
  const { selected } = await owner();
  advanceFederationSessionGeneration();
  const install = vi.fn();
  expect(() => selected.prepareRuntime(install)).toThrow("changed");
  expect(install).not.toHaveBeenCalled();
});
it("one synchronous guarded native port installation can advance its own generation once", async () => {
  const { selected } = await owner();
  selected.prepareRuntime(advanceFederationSessionGeneration);
  expect(() => selected.assertPending()).not.toThrow();
  expect(() => selected.prepareRuntime(() => undefined)).toThrow(
    "already prepared",
  );
});
it("an explicit original vault lock cancels and never revives the owner", async () => {
  await vaultStore.createGuest();
  const { selected } = await owner();
  await vaultStore.lock();
  expect(selected.signal.aborted).toBe(true);
  await vaultStore.createGuest();
  expect(() => selected.assertPending()).toThrow();
});
it.each(["pin", "password"])(
  "ordinary original %s unlock preserves the admitted owner but cannot resume an old pending ceremony",
  async (mode) => {
    if (mode === "pin") await vaultStore.createWithPin("82946731");
    else await vaultStore.create("Public synthetic owner password 2026!");
    await vaultStore.lock();
    const { selected, draft } = await owner();
    if (mode === "pin") await vaultStore.unlockWithPin("82946731");
    else await vaultStore.unlock("Public synthetic owner password 2026!");
    expect(vaultStore.getSnapshot().status).toBe("unlocked");
    expect(() =>
      selected.assertSessionCurrent(draft.samlEntityId, draft.clientId),
    ).not.toThrow();
    expect(() => selected.assertPending()).toThrow("ceremony changed");
  },
);
it("normal first-vault setup in the original empty tomb can retain the same identity owner", async () => {
  const { selected, draft } = await owner();
  expect(vaultStore.getSnapshot().status).toBe("empty");
  await vaultStore.createWithPin("82946731");
  expect(() =>
    selected.assertSessionCurrent(draft.samlEntityId, draft.clientId),
  ).not.toThrow();
  expect(() => selected.assertPending()).toThrow("ceremony changed");
});
it("releasing an originating owner is irreversible and removes its listeners", async () => {
  const { selected } = await owner();
  selected.release();
  selected.release();
  expect(selected.signal.aborted).toBe(true);
  expect(() => selected.assertPending()).toThrow();
});

it("OIDC captures its saved issuer/client/secret revision and refuses an identical resave", async () => {
  const { selected, draft, saved } = await owner("oidc");
  expect(() =>
    selected.assertSessionCurrent(draft.issuer, draft.clientId),
  ).not.toThrow();
  expect(() =>
    selected.assertSessionCurrent("https://other.example.test", draft.clientId),
  ).toThrow();
  await writeIdentityConnection(draft, saved.connectionId);
  expect(selected.signal.aborted).toBe(true);
  expect(() => selected.assertPending()).toThrow();
});
it("LDAP cannot capture an invented realm without its explicit adapter resolver", () => {
  expect(() => captureNativeIdentityOwner("missing", "ldap")).toThrow(
    /exact configured realm/,
  );
});
