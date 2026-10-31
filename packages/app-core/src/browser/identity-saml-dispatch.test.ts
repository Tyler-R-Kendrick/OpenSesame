/** @vitest-environment jsdom */
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { fenceLocalSignOut } from "../lib/ambient-auth/generation.js";
import {
  advanceFederationSessionGeneration,
  federationSessionGeneration,
  readNativeFederationSession,
} from "../lib/federation-native-session.js";
import { readFederationSessionJson } from "../lib/federation-session-store.js";
import { clearSession, saveSession } from "../lib/federation.js";
import { identityConnectionDraft } from "../lib/identity-connections-presets.js";
import { writeIdentityConnection } from "../lib/identity-connections-store.js";
import * as nativeOwner from "../lib/identity-native-owner.js";
import { kvFlush, kvForgetAll, kvSeams } from "../lib/kv.js";
import {
  type NativeProviderTransport,
  bindNativeProviderTransport,
} from "../lib/native-connector-transport.js";
import {
  loadSettings,
  saveSettingsDurable,
  signInMethods,
} from "../lib/settings.js";
import { vaultStore } from "../lib/vault/store.js";
import { vfsFlush } from "../lib/vfs.js";
import { createMemoryStorage } from "../memory-storage.js";
import { createTestHost } from "../test-host.js";
import {
  beginSavedNativeSaml,
  captureSamlConfiguration,
} from "./identity-saml-dispatch.js";
import * as popupPort from "./native-auth-session.js";
import {
  configuredSamlOracle,
  configuredSamlTls,
} from "./saml/configured-runtime.test-support.js";
const releases: (() => void)[] = [];
let oracle: Awaited<ReturnType<typeof configuredSamlOracle>>;
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
  vi.stubGlobal("crypto", webcrypto);
  oracle = await configuredSamlOracle();
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
async function saved(url = "") {
  const draft = {
    ...identityConnectionDraft("byo-identity"),
    protocol: "saml" as const,
    clientId: "urn:configured:sp",
    samlEntityId: "urn:configured:idp",
    samlMetadataUrl: url,
    samlMetadataXml: url ? "" : oracle.metadata,
    samlAuthnContext: "urn:configured:context",
  };
  const connection = await writeIdentityConnection(draft);
  await saveSettingsDurable({
    ...loadSettings(),
    signIn: {
      ...signInMethods(),
      providers: [
        {
          providerId: draft.providerId,
          protocol: "saml",
          label: draft.name,
          connectionId: connection.connectionId,
          issuer: draft.samlEntityId,
          clientId: draft.clientId,
        },
      ],
    },
  });
  return { draft, id: connection.connectionId };
}
function popup(events: string[]) {
  vi.spyOn(window, "open").mockImplementation(() => {
    events.push("popup");
    return window;
  });
  const cancel = vi.fn(() => events.push("popup-release"));
  vi.spyOn(popupPort, "resumeNativeAuthPopup").mockReturnValue({
    cancel,
    wait: vi.fn(),
    waitWebMessage: vi.fn(),
    showDeviceConsent: vi.fn(),
    showRedirectConsent: vi.fn(),
    showFormConsent: vi.fn(() => {
      events.push("consent");
      return { signal: new AbortController().signal, close() {} };
    }),
  });
  return cancel;
}
function heldHydration(events: string[]) {
  let resume: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    resume = resolve;
  });
  vi.spyOn(kvSeams, "kvHydrate").mockImplementation(async () => {
    events.push("hydrate");
    await pending;
  });
  return resume;
}
it.each(["registration", "method", "signal", "signout", "revision"] as const)(
  "captures before hydration and refuses %s withdrawal without adopting replacement",
  async (reason) => {
    const tls = await configuredSamlTls(oracle.metadata);
    try {
      const { id, draft } = await saved(tls.url);
      const events: string[] = [];
      const cancel = popup(events);
      const snapshot: NativeProviderTransport = {
        fetch: vi.fn(tls.fetch),
        assertCurrent() {},
        signal: new AbortController().signal,
      };
      const original = {
        fetch: vi.fn(tls.fetch),
        assertCurrent() {},
        capture: vi.fn(() => {
          events.push("capture");
          return snapshot;
        }),
      };
      releases.push(bindNativeProviderTransport(original));
      const resume = heldHydration(events);
      const active = beginSavedNativeSaml(id);
      const refusal = expect(active).rejects.toThrow();
      expect(events).toEqual(["capture", "popup", "hydrate"]);
      const replacement = { fetch: vi.fn(tls.fetch), assertCurrent() {} };
      if (reason === "registration")
        releases.push(bindNativeProviderTransport(replacement));
      if (reason === "method") snapshot.fetch = vi.fn(tls.fetch);
      if (reason === "signal")
        Object.defineProperty(snapshot, "signal", {
          value: new AbortController().signal,
        });
      if (reason === "signout") fenceLocalSignOut();
      if (reason === "revision") await writeIdentityConnection(draft, id);
      resume();
      await refusal;
      expect(original.capture).toHaveBeenCalledOnce();
      expect(original.fetch).not.toHaveBeenCalled();
      expect(replacement.fetch).not.toHaveBeenCalled();
      expect(tls.requests).toHaveLength(0);
      expect(cancel).toHaveBeenCalledOnce();
      expect(readNativeFederationSession()).toBeNull();
    } finally {
      await tls.close();
    }
  },
);
it.each([false, true])(
  "uses genuine signed proof and its original TLS route, tamper=%s",
  async (tamper) => {
    const tls = await configuredSamlTls(oracle.metadata);
    try {
      const { id } = await saved(tls.url);
      const events: string[] = [];
      popup(events);
      oracle.install(events, tamper);
      const original = {
        fetch: vi.fn(tls.fetch),
        assertCurrent() {},
        capture: vi.fn(function (this: { marker: boolean }) {
          expect(this.marker).toBe(true);
          return { fetch: tls.fetch, assertCurrent() {} };
        }),
        marker: true,
      };
      releases.push(bindNativeProviderTransport(original));
      const ambient = vi.spyOn(globalThis, "fetch");
      if (tamper) await expect(beginSavedNativeSaml(id)).rejects.toThrow();
      else await beginSavedNativeSaml(id);
      expect(original.capture).toHaveBeenCalledOnce();
      expect(ambient).not.toHaveBeenCalled();
      expect(tls.requests).toEqual([
        {
          path: "/metadata?tenant=owned",
          method: "GET",
          cookie: undefined,
          origin: undefined,
        },
      ]);
      expect(events.indexOf("protocol-release")).toBeGreaterThan(
        events.indexOf("consent"),
      );
      expect(readNativeFederationSession()?.assertionFormat ?? null).toBe(
        tamper ? null : "saml",
      );
    } finally {
      await tls.close();
    }
  },
);
it("aborts held metadata on original owner withdrawal and closes the physical TLS request", async () => {
  const tls = await configuredSamlTls(oracle.metadata);
  try {
    tls.hold();
    const { id } = await saved(tls.url);
    popup([]);
    releases.push(
      bindNativeProviderTransport({ fetch: tls.fetch, assertCurrent() {} }),
    );
    const active = beginSavedNativeSaml(id);
    const refusal = expect(active).rejects.toThrow();
    await vi.waitFor(() => expect(tls.requests).toHaveLength(1));
    expect(tls.closed()).toBe(false);
    fenceLocalSignOut();
    // Sign-out is checked around each await; vault lock also broadcasts immediate owner cancellation.
    vaultStore.lock();
    await refusal;
    await vi.waitFor(() => expect(tls.closed()).toBe(true), { timeout: 2000 });
    expect(readNativeFederationSession()).toBeNull();
  } finally {
    await tls.close();
  }
});
it("refuses an activation replaced after metadata while the genuinely signed proof is prepared", async () => {
  const tls = await configuredSamlTls(oracle.metadata);
  try {
    const { id } = await saved(tls.url);
    popup([]);
    releases.push(
      bindNativeProviderTransport({ fetch: tls.fetch, assertCurrent() {} }),
    );
    const receiver = oracle.install([]);
    const verify = receiver.getMockImplementation();
    if (!verify) throw new Error("Expected independent signed oracle");
    const replacement = { fetch: vi.fn(tls.fetch), assertCurrent() {} };
    receiver.mockImplementation(async (options) => {
      const result = await verify(options);
      releases.push(bindNativeProviderTransport(replacement));
      return result;
    });
    await expect(beginSavedNativeSaml(id)).rejects.toThrow(
      "activation changed",
    );
    expect(replacement.fetch).not.toHaveBeenCalled();
    expect(readNativeFederationSession()).toBeNull();
  } finally {
    await tls.close();
  }
});

/** The hook observes an actual configured owner's release after independent XML signature verification. */
async function signedSessionRetirementHook(onRelease: () => void) {
  const capture = nativeOwner.captureNativeIdentityOwner;
  let armed = false;
  vi.spyOn(nativeOwner, "captureNativeIdentityOwner").mockImplementation(
    (...args) => {
      const owner = capture(...args);
      owner.signal.addEventListener(
        "abort",
        () => {
          if (!armed) return;
          armed = false;
          onRelease();
        },
        { once: true },
      );
      return owner;
    },
  );
  const { id } = await saved();
  popup([]);
  oracle.install([]);
  await beginSavedNativeSaml(id);
  expect(readNativeFederationSession()?.assertionFormat).toBe("saml");
  return () => {
    armed = true;
  };
}
const successorMetadata = () => ({
  issuer: "https://shoo.dev",
  upstreamId: "shoo",
  idToken: "opaque-successor-metadata",
  assertionFormat: "opaque" as const,
  pairwiseSub: "newer-subject",
  audience: "origin:successor",
  jwksUri: "https://shoo.dev/keys",
  expiresAt: Date.now() + 60000,
});
it("explicit logout preserves newer metadata published by genuine native session cleanup", async () => {
  const successor = successorMetadata();
  let published = federationSessionGeneration();
  const arm = await signedSessionRetirementHook(() => {
    published = saveSession(successor);
  });
  arm();
  expect(clearSession()).toBeUndefined();
  expect(federationSessionGeneration()).toBe(published);
  expect(readFederationSessionJson()).toBe(JSON.stringify(successor));
  expect(readNativeFederationSession()).toBeNull();
});

it.each(["generation", "metadata"])(
  "configuration retirement rejects genuine cleanup successor %s without borrowing it",
  async (kind) => {
    const successor = successorMetadata();
    let published = federationSessionGeneration();
    const arm = await signedSessionRetirementHook(() => {
      published =
        kind === "metadata"
          ? saveSession(successor)
          : advanceFederationSessionGeneration();
    });
    const configuration = captureSamlConfiguration("");
    try {
      arm();
      expect(() => configuration.clearOwnSession()).toThrow(
        /superseded|authority changed/,
      );
      expect(federationSessionGeneration()).toBe(published);
      expect(readFederationSessionJson()).toBe(
        kind === "metadata" ? JSON.stringify(successor) : null,
      );
      expect(() => configuration.assertActor()).toThrow(/authority changed/);
      expect(readNativeFederationSession()).toBeNull();
    } finally {
      await configuration.release();
    }
  },
);
