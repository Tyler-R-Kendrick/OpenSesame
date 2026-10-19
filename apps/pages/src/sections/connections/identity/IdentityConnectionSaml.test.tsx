/** @vitest-environment jsdom */
import { webcrypto } from "node:crypto";
import * as popupPort from "@opensesame/app-core/browser/native-auth-session.js";
import {
  configuredSamlOracle,
  configuredSamlTls,
} from "@opensesame/app-core/browser/saml/configured-runtime.test-support.js";
import { configureHost } from "@opensesame/app-core/host.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceSecrets,
} from "@opensesame/app-core/lib/device-connector-records.js";
import { readNativeFederationSession } from "@opensesame/app-core/lib/federation-native-session.js";
import {
  listIdentityConnections,
  readIdentityConnection,
  removeIdentityConnection,
} from "@opensesame/app-core/lib/identity-connections.js";
import { kvFlush, kvForgetAll, kvSeams } from "@opensesame/app-core/lib/kv.js";
import { bindNativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import { signInMethods } from "@opensesame/app-core/lib/settings.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { vfsFlush } from "@opensesame/app-core/lib/vfs.js";
import { createMemoryStorage } from "@opensesame/app-core/memory-storage.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startConfiguredIdentity } from "../../../screens/unlock/ConfiguredIdentityStage.js";
import { NativeInputFields } from "../connect/NativeConnectorFields.js";
import { IdentityConnectionPanels } from "./IdentityConnectionPanels.js";

const disk = new Map<string, string>();
const memory = new Map<string, string>();
const releases: (() => void)[] = [];
const events: string[] = [];
let oracle: Awaited<ReturnType<typeof configuredSamlOracle>>;
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
  cleanup();
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
function provider(id: string): Provider {
  return {
    id,
    displayName: id,
    category: "identity",
    authKind: "configuration",
    configured: false,
    docsUrl: "https://example.com/docs",
    supportsRefresh: false,
    autoConfigurable: false,
    missingConfig: [],
    callbackUrl: null,
    scopes: [],
    egress: { scheme: "https", authorities: [], pathPrefixes: [] },
    operations: [],
  };
}
function draw(id = "byo-identity") {
  return render(
    <IdentityConnectionPanels
      provider={provider(id)}
      connection={null}
      online
      onFlash={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
}
function field(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
async function configure(id: string, url = "") {
  draw(id);
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText("Protocol"), "saml");
  field("Service provider entity ID", "urn:configured:sp");
  field("Identity provider entity ID", "urn:configured:idp");
  field("Authentication context URI (optional)", "urn:configured:context");
  if (url) field("SAML metadata URL", url);
  else field("Metadata XML (alternative to URL)", oracle.metadata);
  expect(screen.queryByLabelText("Identity service URL")).toBeNull();
  expect(screen.queryByLabelText("Organization")).toBeNull();
  expect(screen.getByLabelText("SAML ACS URL to register")).toHaveProperty(
    "value",
    expect.stringContaining("/auth/native-saml"),
  );
  expect(
    screen.getByLabelText("SP signing private key (PKCS8 PEM)"),
  ).toHaveProperty("type", "password");
  expect(screen.getByLabelText("SP signing certificate (PEM)").tagName).toBe(
    "TEXTAREA",
  );
  expect(
    screen.getByLabelText("Metadata XML (alternative to URL)"),
  ).toHaveProperty("maxLength", 262144);
  expect(screen.getByLabelText("Require fresh authentication")).toHaveProperty(
    "value",
    "false",
  );
  return user;
}
function popup() {
  vi.spyOn(window, "open").mockImplementation(() => {
    events.push("popup");
    return window;
  });
  const consent = vi.fn(() => {
    events.push("consent");
    return { signal: new AbortController().signal, close() {} };
  });
  vi.spyOn(popupPort, "resumeNativeAuthPopup").mockReturnValue({
    cancel: vi.fn(),
    wait: vi.fn(),
    waitWebMessage: vi.fn(),
    showDeviceConsent: vi.fn(),
    showRedirectConsent: vi.fn(),
    showFormConsent: consent,
  });
  return consent;
}
async function save(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: "Save identity connection" }),
  );
  await waitFor(() => expect(listIdentityConnections()).toHaveLength(1));
  const saved = listIdentityConnections()[0];
  if (!saved) throw new Error("Missing saved SAML configuration");
  return saved;
}
function cold() {
  for (const key of DEVICE_CONNECTOR_KEYS) memory.delete(key);
  kvForgetAll();
  events.length = 0;
}
it("BYO settings test/save seals metadata and cold unlock uses genuine proof and one original consent window", async () => {
  const user = await configure("byo-identity");
  const ambient = vi.spyOn(globalThis, "fetch");
  await user.click(
    screen.getByRole("button", { name: "Test identity connection" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("img", { name: /Complete sign-in/ })).toBeTruthy(),
  );
  expect(listIdentityConnections()).toHaveLength(0);
  expect(readNativeFederationSession()).toBeNull();
  const saved = await save(user);
  expect(readIdentityConnection(saved.connectionId)?.samlMetadataXml).toBe("");
  expect(readDeviceSecrets()[saved.connectionId]?.samlMetadataXml).toBe(
    oracle.metadata,
  );
  expect([...disk.values()].join("\n")).not.toContain(oracle.metadata);
  const idp = signInMethods().providers.find(
    (entry) => entry.connectionId === saved.connectionId,
  );
  if (!idp) throw new Error("Missing public SAML projection");
  cleanup();
  cold();
  expect(readIdentityConnection(saved.connectionId)).toBeNull();
  const consent = popup();
  oracle.install(events);
  let pending: Promise<void> | undefined;
  render(
    <button
      type="button"
      onClick={() =>
        startConfiguredIdentity(idp, {
          open: vi.fn(),
          legacy: vi.fn(),
          fail: vi.fn(),
          start: (run) => {
            pending = run();
          },
        })
      }
    >
      Use saved SSO
    </button>,
  );
  await user.click(screen.getByRole("button", { name: "Use saved SSO" }));
  await pending;
  expect(events.indexOf("popup")).toBeLessThan(events.indexOf("hydrate"));
  expect(window.open).toHaveBeenCalledOnce();
  expect(consent).toHaveBeenCalledOnce();
  expect(events.indexOf("protocol-release")).toBeGreaterThan(
    events.indexOf("consent"),
  );
  expect(readNativeFederationSession()).toMatchObject({
    assertionFormat: "saml",
    upstreamId: `identity:${saved.connectionId}`,
    issuer: "urn:configured:idp",
    audience: "urn:configured:sp",
    idToken: "",
    jwksUri: "",
  });
  expect(ambient).not.toHaveBeenCalled();
  await removeIdentityConnection(saved.connectionId);
  expect(readNativeFederationSession()).toBeNull();
});
it("partner settings consume the original verified TLS metadata and genuine SAML result without browser fetch", async () => {
  const tls = await configuredSamlTls(oracle.metadata);
  try {
    const capture = vi.fn(() => {
      events.push("capture");
      return { fetch: tls.fetch, assertCurrent() {} };
    });
    releases.push(
      bindNativeProviderTransport({
        fetch: tls.fetch,
        assertCurrent() {},
        capture,
      }),
    );
    const ambient = vi.spyOn(globalThis, "fetch");
    const user = await configure("okta", tls.url);
    const saved = await save(user);
    expect(readNativeFederationSession()).toBeNull();
    popup();
    oracle.install(events);
    capture.mockClear();
    events.length = 0;
    await user.click(screen.getByRole("button", { name: /Sign in to/ }));
    await waitFor(() =>
      expect(readNativeFederationSession()?.upstreamId).toBe(
        `identity:${saved.connectionId}`,
      ),
    );
    expect(capture).toHaveBeenCalledOnce();
    expect(window.open).toHaveBeenCalledOnce();
    expect(tls.requests).toHaveLength(2);
    expect(
      tls.requests.every(
        (request) =>
          request.method === "GET" &&
          request.path === "/metadata?tenant=owned" &&
          !request.cookie &&
          !request.origin,
      ),
    ).toBe(true);
    expect(ambient).not.toHaveBeenCalled();
  } finally {
    await tls.close();
  }
});
it("cold saved SAML captures the original route before UI hydration and refuses its replacement", async () => {
  const tls = await configuredSamlTls(oracle.metadata);
  try {
    const capture = vi.fn(() => {
      events.push("capture");
      return { fetch: tls.fetch, assertCurrent() {} };
    });
    releases.push(
      bindNativeProviderTransport({
        fetch: tls.fetch,
        assertCurrent() {},
        capture,
      }),
    );
    const user = await configure("byo-identity", tls.url);
    const saved = await save(user);
    const idp = signInMethods().providers.find(
      (entry) => entry.connectionId === saved.connectionId,
    );
    if (!idp) throw new Error("Missing public SAML projection");
    cleanup();
    cold();
    capture.mockClear();
    popup();
    let resume = () => {};
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    vi.spyOn(kvSeams, "kvHydrate").mockImplementation(async () => {
      events.push("hydrate");
      await held;
    });
    let pending: Promise<void> | undefined;
    startConfiguredIdentity(idp, {
      open: vi.fn(),
      legacy: vi.fn(),
      fail: vi.fn(),
      start: (run) => {
        pending = run();
      },
    });
    const refusal = expect(pending).rejects.toThrow();
    expect(events.slice(0, 3)).toEqual(["capture", "popup", "hydrate"]);
    const replacement = vi.fn(tls.fetch);
    releases.push(
      bindNativeProviderTransport({ fetch: replacement, assertCurrent() {} }),
    );
    resume();
    await refusal;
    expect(capture).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
    expect(tls.requests).toHaveLength(1);
    expect(readNativeFederationSession()).toBeNull();
  } finally {
    await tls.close();
  }
});
it("the existing settings sign-in path refuses tampered genuine responses without admitting a local identity", async () => {
  const user = await configure("byo-identity");
  await save(user);
  popup();
  oracle.install(events, true);
  await user.click(screen.getByRole("button", { name: /Sign in to/ }));
  await waitFor(() =>
    expect(
      within(
        screen.getByRole("region", { name: "Identity sign-in" }),
      ).getByRole("img", {
        name: /signature|SAML|verification|response/i,
      }),
    ).toBeTruthy(),
  );
  expect(readNativeFederationSession()).toBeNull();
});

it("the shared textarea honors declared bounds and preserves its unrelated default", () => {
  render(
    <NativeInputFields
      fields={[
        {
          id: "other",
          label: "Other public configuration",
          kind: "textarea",
          secret: false,
          required: false,
        },
        {
          id: "bounded",
          label: "Explicitly bounded configuration",
          kind: "textarea",
          secret: false,
          required: false,
          maxLength: 16384,
        },
      ]}
      values={{}}
      onChange={vi.fn()}
    />,
  );
  expect(screen.getByLabelText("Other public configuration")).toHaveProperty(
    "maxLength",
    100000,
  );
  expect(
    screen.getByLabelText("Explicitly bounded configuration"),
  ).toHaveProperty("maxLength", 16384);
});
