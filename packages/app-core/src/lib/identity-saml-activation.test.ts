/** @vitest-environment jsdom */
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  holdSamlSavePhase,
  samlSaveFixture,
} from "../browser/saml/configured-runtime.test-support.js";
import {
  configuredSamlOracle,
  configuredSamlTls,
} from "../browser/saml/configured-runtime.test-support.js";
import { configureHost } from "../host.js";
import { createMemoryStorage } from "../memory-storage.js";
import { createTestHost } from "../test-host.js";
import { fenceLocalSignOut } from "./ambient-auth/generation.js";
import { subscribeDeviceRows } from "./device-connector-records.js";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
  readDeviceSecrets,
} from "./device-connector-records.js";
import { readNativeFederationSession } from "./federation-native-session.js";
import { clearSession } from "./federation.js";
import { captureConfiguredIdentitySessionOwner } from "./identity-connections-admission.js";
import {
  getIdentityConnectionRuntime,
  identityConnectionRevision,
  writeIdentityConnection,
} from "./identity-connections-store.js";
import { projectIdentityTrust } from "./identity-connections-trust.js";
import {
  beginIdentityConnectionSignIn,
  identityConnectionDraft,
  identityConnectionProblems,
  readIdentityConnection,
  removeIdentityConnection,
  saveIdentityConnection,
  testIdentityConnection,
} from "./identity-connections.js";
import { configuredSamlPopup } from "./identity-saml-popup.test-support.js";
import { kvFlush, kvForgetAll, kvHydrate, kvSeams } from "./kv.js";
import { bindNativeProviderTransport } from "./native-connector-transport.js";
import { signInMethods } from "./settings.js";
import { vaultStore } from "./vault/store.js";
import { vfsFlush } from "./vfs.js";
const disk = new Map<string, string>();
const memory = new Map<string, string>();
const releases: (() => void)[] = [];
let oracle: Awaited<ReturnType<typeof configuredSamlOracle>>;
const events: string[] = [];
beforeEach(async () => {
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await kvFlush();
  vaultStore.lock();
  kvForgetAll();
  disk.clear();
  memory.clear();
  events.length = 0;
  configureHost(
    createTestHost({
      storage: { local: createMemoryStorage(), session: createMemoryStorage() },
    }),
  );
  vaultStore.loadActiveProjectScope();
  vi.stubGlobal("crypto", webcrypto);
  oracle = await configuredSamlOracle();
  vi.spyOn(kvSeams, "kvGet").mockImplementation(
    (key) => memory.get(key) ?? null,
  );
  vi.spyOn(kvSeams, "kvSetDurable").mockImplementation(async (key, value) => {
    disk.set(key, value);
    memory.set(key, value);
  });
  vi.spyOn(kvSeams, "kvHydrate").mockImplementation(async (keys) => {
    events.push("hydrate");
    for (const key of keys) {
      const value = disk.get(key);
      if (value !== undefined) memory.set(key, value);
    }
  });
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await kvFlush();
  vaultStore.lock();
  await vfsFlush();
  await kvFlush();
});
function draft(url = "") {
  return {
    ...identityConnectionDraft("byo-identity"),
    protocol: "saml" as const,
    clientId: "urn:configured:sp",
    samlEntityId: "urn:configured:idp",
    samlMetadataXml: url ? "" : oracle.metadata,
    samlMetadataUrl: url,
    samlAuthnContext: "urn:configured:context",
  };
}
it("native SAML accepts exact URN entities, enforces shared signing validation and requires no broker", () => {
  expect(identityConnectionProblems(draft())).toEqual([]);
  expect(
    identityConnectionProblems({
      ...draft(),
      samlSigningCertificate: "public-certificate",
    }).join(" "),
  ).toContain("both");
  expect(
    identityConnectionProblems({
      ...draft(),
      samlEntityId: "javascript:foreign",
    }).join(" "),
  ).toContain("entity ID");
});
it("configuration checks cannot authenticate or persist a native session", async () => {
  const ambient = vi.spyOn(globalThis, "fetch");
  expect((await testIdentityConnection(draft())).message).toContain(
    "Complete sign-in",
  );
  expect(readDeviceRows()).toEqual([]);
  expect(signInMethods().providers).toEqual([]);
  expect(readNativeFederationSession()).toBeNull();
  expect(ambient).not.toHaveBeenCalled();
});
it("saves sealed inline configuration, reloads cold and consumes genuine proof without a network activation", async () => {
  const connection = await saveIdentityConnection(draft());
  expect(readIdentityConnection(connection.connectionId)?.samlMetadataXml).toBe(
    "",
  );
  expect(readDeviceSecrets()[connection.connectionId]?.samlMetadataXml).toBe(
    oracle.metadata,
  );
  expect([...disk.values()].join("\n")).not.toContain(oracle.metadata);
  expect(
    signInMethods().providers.find(
      (p) => p.connectionId === connection.connectionId,
    ),
  ).toMatchObject({
    protocol: "saml",
    issuer: "urn:configured:idp",
    clientId: "urn:configured:sp",
  });
  for (const key of DEVICE_CONNECTOR_KEYS) memory.delete(key);
  kvForgetAll();
  expect(readIdentityConnection(connection.connectionId)).toBeNull();
  configuredSamlPopup(events);
  oracle.install(events);
  const ambient = vi.spyOn(globalThis, "fetch");
  await beginIdentityConnectionSignIn(connection.connectionId);
  expect(events.indexOf("popup")).toBeLessThan(events.indexOf("hydrate"));
  expect(readNativeFederationSession()).toMatchObject({
    upstreamId: `identity:${connection.connectionId}`,
    assertionFormat: "saml",
    idToken: "",
    jwksUri: "",
    issuer: "urn:configured:idp",
    audience: "urn:configured:sp",
  });
  expect(ambient).not.toHaveBeenCalled();
  await removeIdentityConnection(connection.connectionId);
  expect(readNativeFederationSession()).toBeNull();
  expect(signInMethods().providers).toEqual([]);
});
it("cold URL sign-in retains one original route before hydration and spends the genuine result", async () => {
  const tls = await configuredSamlTls(oracle.metadata);
  try {
    const original = {
      fetch: tls.fetch,
      assertCurrent() {},
      capture: vi.fn(() => {
        events.push("capture");
        return { fetch: tls.fetch, assertCurrent() {} };
      }),
    };
    releases.push(bindNativeProviderTransport(original));
    const connection = await saveIdentityConnection(draft(tls.url));
    expect(readNativeFederationSession()).toBeNull();
    expect(tls.requests).toHaveLength(1);
    for (const key of DEVICE_CONNECTOR_KEYS) memory.delete(key);
    kvForgetAll();
    events.length = 0;
    original.capture.mockClear();
    configuredSamlPopup(events);
    oracle.install(events);
    await beginIdentityConnectionSignIn(connection.connectionId);
    expect(events.slice(0, 3)).toEqual(["capture", "popup", "hydrate"]);
    expect(original.capture).toHaveBeenCalledOnce();
    expect(tls.requests).toHaveLength(2);
    expect(readNativeFederationSession()?.upstreamId).toBe(
      `identity:${connection.connectionId}`,
    );
  } finally {
    await tls.close();
  }
});
it("cannot silently adopt a route enabled during cold hydration", async () => {
  const tls = await configuredSamlTls(oracle.metadata);
  try {
    const unbind = bindNativeProviderTransport({
      fetch: tls.fetch,
      assertCurrent() {},
    });
    const connection = await saveIdentityConnection(draft(tls.url));
    unbind();
    for (const key of DEVICE_CONNECTOR_KEYS) memory.delete(key);
    kvForgetAll();
    configuredSamlPopup(events);
    const later = { fetch: vi.fn(tls.fetch), assertCurrent() {} };
    const hydrate = vi.mocked(kvSeams.kvHydrate).getMockImplementation();
    if (!hydrate) throw new Error("Expected independent cold ledger hydration");
    vi.spyOn(kvSeams, "kvHydrate").mockImplementation(async (keys) => {
      releases.push(bindNativeProviderTransport(later));
      await hydrate(keys);
    });
    await expect(
      beginIdentityConnectionSignIn(connection.connectionId),
    ).rejects.toThrow("Original SAML metadata route is unavailable");
    expect(later.fetch).not.toHaveBeenCalled();
    expect(tls.requests).toHaveLength(1);
    expect(readNativeFederationSession()).toBeNull();
  } finally {
    await tls.close();
  }
});

it.each([
  "queue",
  "record-stage",
  "record-close",
  "trust-stage",
  "trust-callback",
  "federation-close",
] as const)(
  "never reports Saved or enables new trust after original actor withdrawal at %s",
  async (phase) => {
    const fixture = await samlSaveFixture();
    const withdraw =
      phase === "federation-close" ? clearSession : fenceLocalSignOut;
    const held = await holdSamlSavePhase(
      phase === "federation-close" ? "record-close" : phase,
      withdraw,
    );
    const pending = saveIdentityConnection({
      ...draft(),
      name: "Attempted save",
    });
    const outcome = pending.then(
      () => true,
      () => false,
    );
    try {
      await held.reached;
      if (phase !== "trust-callback") withdraw();
      held.resume();
      expect(await outcome).toBe(false);
      expect(readDeviceRows()).toEqual([]);
      expect(signInMethods().providers).toEqual([]);
      kvForgetAll();
      await kvHydrate([...DEVICE_CONNECTOR_KEYS, "settings.v1"]);
      expect(readDeviceRows()).toEqual([]);
      expect(signInMethods().providers).toEqual([]);
    } finally {
      await held.close();
      await outcome;
      await fixture.close();
    }
  },
);
it.each(["record-close", "trust-callback"] as const)(
  "restores an earlier configured connection with a fresh revision after %s withdrawal",
  async (phase) => {
    const fixture = await samlSaveFixture();
    const prior = { ...draft(), name: "Earlier saved identity" };
    const saved = await writeIdentityConnection(prior);
    await projectIdentityTrust(prior, saved.connectionId);
    const revision = identityConnectionRevision(saved.connectionId);
    const providers = signInMethods().providers;
    const secrets = readDeviceSecrets();
    const previousOwner = captureConfiguredIdentitySessionOwner(
      saved.connectionId,
    );
    let failedOwner:
      | ReturnType<typeof captureConfiguredIdentitySessionOwner>
      | undefined;
    const held = await holdSamlSavePhase(phase, fenceLocalSignOut);
    const outcome = saveIdentityConnection(
      { ...draft(), name: "Attempted replacement" },
      saved.connectionId,
    ).then(
      () => true,
      () => false,
    );
    try {
      await held.reached;
      const attemptedRevision = identityConnectionRevision(saved.connectionId);
      failedOwner = captureConfiguredIdentitySessionOwner(saved.connectionId);
      expect(attemptedRevision).not.toBe(revision);
      if (phase !== "trust-callback") fenceLocalSignOut();
      held.resume();
      expect(await outcome).toBe(false);
      expect(getIdentityConnectionRuntime(saved.connectionId)).toEqual(prior);
      // Both hooks run after durable publication. Compensation republishes
      // the previous bytes under a fresh revision, so neither attempt revives.
      const restoredRevision = identityConnectionRevision(saved.connectionId);
      expect(restoredRevision).toEqual(expect.any(String));
      expect(restoredRevision).not.toBe(revision);
      expect(restoredRevision).not.toBe(attemptedRevision);
      expect(() => previousOwner.assertCurrent()).toThrow();
      expect(() => failedOwner?.assertCurrent()).toThrow();
      expect(readDeviceSecrets()).toEqual(secrets);
      expect(signInMethods().providers).toEqual(providers);
      kvForgetAll();
      await kvHydrate([...DEVICE_CONNECTOR_KEYS, "settings.v1"]);
      expect(getIdentityConnectionRuntime(saved.connectionId)).toEqual(prior);
      expect(identityConnectionRevision(saved.connectionId)).toBe(
        restoredRevision,
      );
      expect(signInMethods().providers).toEqual(providers);
    } finally {
      previousOwner.release();
      failedOwner?.release();
      await held.close();
      await outcome;
      await fixture.close();
    }
  },
);
it("preserves a real queued successor with identical public trust and different private metadata", async () => {
  const fixture = await samlSaveFixture();
  const attempt = { ...draft(), name: "Shared public identity" };
  const replacement = {
    ...attempt,
    samlMetadataXml: `${attempt.samlMetadataXml}\n`,
  };
  let newer: Promise<string> = Promise.resolve("");
  const unsubscribe = subscribeDeviceRows(() => {
    unsubscribe();
    fenceLocalSignOut();
    const id = readDeviceRows()[0]?.connectionId;
    if (!id) throw new Error("Expected original committed row");
    newer = writeIdentityConnection(replacement, id).then(async (saved) => {
      await projectIdentityTrust(replacement, saved.connectionId);
      return saved.connectionId;
    });
  });
  try {
    const outcome = saveIdentityConnection(attempt).then(
      () => true,
      () => false,
    );
    expect(await outcome).toBe(false);
    const id = await newer;
    expect(getIdentityConnectionRuntime(id)).toEqual(replacement);
    expect(
      signInMethods().providers.find(
        (provider) => provider.connectionId === id,
      ),
    ).toMatchObject({ label: attempt.name, issuer: attempt.samlEntityId });
    kvForgetAll();
    await kvHydrate([...DEVICE_CONNECTOR_KEYS, "settings.v1"]);
    expect(getIdentityConnectionRuntime(id)).toEqual(replacement);
    expect(
      signInMethods().providers.some(
        (provider) => provider.connectionId === id,
      ),
    ).toBe(true);
  } finally {
    unsubscribe();
    await newer;
    await fixture.close();
  }
});

it("edits its own active SAML connection while retiring the old verified session", async () => {
  const fixture = await samlSaveFixture();
  try {
    const saved = await saveIdentityConnection(draft());
    configuredSamlPopup(events);
    oracle.install(events);
    await beginIdentityConnectionSignIn(saved.connectionId);
    expect(readNativeFederationSession()?.upstreamId).toBe(
      `identity:${saved.connectionId}`,
    );
    const edited = await saveIdentityConnection(
      { ...draft(), name: "Reconfigured identity" },
      saved.connectionId,
    );
    expect(edited.displayName).toBe("Reconfigured identity");
    expect(getIdentityConnectionRuntime(saved.connectionId)?.name).toBe(
      "Reconfigured identity",
    );
    expect(readNativeFederationSession()).toBeNull();
  } finally {
    await fixture.close();
  }
});
