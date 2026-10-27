import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { page } from "../ports.js";
import type { PagePort } from "../ports.js";
import { createTestHost } from "../test-host.js";
import { deviceIdentitySeams } from "./device-identity.js";
import { loadSession } from "./federation.js";
import { writeIdentityConnection } from "./identity-connections-store.js";
import { projectIdentityTrust } from "./identity-connections-trust.js";
import {
  beginIdentityConnectionSignIn,
  identityConnectionDraft,
} from "./identity-connections.js";
import * as enterprise from "./identity-enterprise.js";
import { kvForgetAll, kvSeams } from "./kv.js";
import { signInMethods } from "./settings.js";

const issuer = "https://identity.example.com";
function discovery() {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
  };
}
const navigation: string[] = [];
const disk = new Map<string, string>();
const memory = new Map<string, string>();
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (i) => [...values.keys()][i] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
  };
}
function testPage(): PagePort {
  return {
    location: {
      origin: "https://app.example.com",
      hostname: "app.example.com",
      host: "app.example.com",
      protocol: "https:",
      pathname: "/",
      href: "https://app.example.com/",
      search: "",
      hash: "",
      assign: (url) => {
        navigation.push(String(url));
      },
      replace: () => {},
      reload: () => {},
    },
    opener: null,
    isSecureContext: true,
    visibilityState: "visible",
    replaceUrl: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    open: () => null,
    close: () => {},
    onVisibilityChange: () => () => {},
    startDownload: () => {},
    submitForm: () => {},
  };
}
beforeEach(() => {
  navigation.length = 0;
  disk.clear();
  memory.clear();
  kvForgetAll();
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
  configureHost(createTestHost({ page: testPage() }));
  vi.spyOn(kvSeams, "kvGet").mockImplementation(
    (key) => memory.get(key) ?? null,
  );
  vi.spyOn(kvSeams, "kvSetDurable").mockImplementation(async (key, value) => {
    disk.set(key, value);
    memory.set(key, value);
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(discovery())),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  configureHost(createTestHost());
});

it("separate saved native organizations remain cold-bound and never fall back to an owner API or broker redirect", async () => {
  const open = vi.fn(() => null);
  configureHost(createTestHost({ page: { ...testPage(), open } }));
  const broker = "https://broker.example.com";
  vi.spyOn(deviceIdentitySeams, "remoteIdentityApi").mockReturnValue(broker);
  const client = enterprise.identityEnterpriseClient();
  const list = vi.fn(async () => {
    throw new Error("Members cannot read owner configuration");
  });
  vi.spyOn(enterprise, "identityEnterpriseClient").mockReturnValue({
    ...client,
    listOrganizations: list,
  });
  const saved = [];
  for (const slug of ["one", "two"]) {
    // Existing sealed rows are seeded through their ordinary storage/trust ports;
    // Test/Save and real TLS primary sign-in run in identity-oidc-dispatch.test.ts.
    const draft = {
      ...identityConnectionDraft("byo-identity"),
      protocol: "oidc" as const,
      organizationId: `org-${slug}`,
      issuer,
      clientId: "organization-client",
      clientSecret: "public synthetic organization fixture",
    };
    const connection = await writeIdentityConnection(draft);
    await projectIdentityTrust(draft, connection.connectionId);
    saved.push(connection);
  }
  memory.clear();
  for (const [key, value] of disk) memory.set(key, value);
  expect(
    signInMethods().providers.map((idp) => ({
      native: idp.nativeIdentity,
      issuer: idp.issuer,
      connectionId: idp.connectionId,
      hint: idp.providerHint,
    })),
  ).toEqual(
    saved.map((connection) => ({
      native: true,
      issuer,
      connectionId: connection.connectionId,
      hint: undefined,
    })),
  );
  expect(saved[0]?.connectionId).not.toBe(saved[1]?.connectionId);
  memory.clear();
  const hydrate = vi
    .spyOn(kvSeams, "kvHydrate")
    .mockImplementation(async (keys) => {
      for (const key of keys) {
        const value = disk.get(key);
        if (value) memory.set(key, value);
      }
    });
  memory.set("settings.v1", disk.get("settings.v1") ?? "");
  vi.mocked(fetch).mockClear();
  // The click must reserve its window before private hydration or Networking.
  for (const connection of saved) {
    await expect(
      beginIdentityConnectionSignIn(connection.connectionId),
    ).rejects.toThrow("Allow the identity sign-in window and try again");
  }
  expect(open.mock.calls).toEqual(
    saved.map(() => ["about:blank", "_blank", "popup,width=600,height=720"]),
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(loadSession()).toBeNull();
  expect(hydrate).not.toHaveBeenCalled();
  const opener = { open: vi.fn() };
  vi.stubGlobal("window", opener);
  const popup = {
    closed: false,
    opener,
    location: { href: "about:blank" },
    close: vi.fn(),
  };
  vi.spyOn(page(), "open").mockReturnValue(
    overlapCast<typeof popup, Window>(popup),
  );
  await expect(
    beginIdentityConnectionSignIn(saved[1]?.connectionId ?? ""),
  ).rejects.toThrow("Enable Networking");
  expect(hydrate).toHaveBeenCalledWith(
    expect.arrayContaining(["opensesame.self-hosted-connectors.v1"]),
  );
  expect(popup.close).toHaveBeenCalledOnce();
  expect(navigation).toEqual([]);
  expect(list).not.toHaveBeenCalled();
});
