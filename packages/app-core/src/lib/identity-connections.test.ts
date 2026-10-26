import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import type { PagePort } from "../ports.js";
import { createTestHost } from "../test-host.js";
import {
  readDeviceRows,
  readDeviceSecrets,
} from "./device-connector-records.js";
import { revokeDeviceConnection } from "./device-connectors.js";
import { deviceIdentitySeams } from "./device-identity.js";
import {
  beginSignIn,
  completeSignIn,
  loadSession,
  operatorUpstream,
} from "./federation.js";
import {
  getIdentityConnectionRuntime,
  writeIdentityConnection,
} from "./identity-connections-store.js";
import { projectIdentityTrust } from "./identity-connections-trust.js";
import {
  beginIdentityConnectionSignIn,
  identityConnectionDraft,
  identityConnectionProblems,
  listIdentityConnections,
  readIdentityConnection,
  removeIdentityConnection,
  saveIdentityConnection,
  testIdentityConnection,
} from "./identity-connections.js";
import * as enterprise from "./identity-enterprise.js";
import { kvForgetAll, kvSeams } from "./kv.js";
import { signInMethods } from "./settings.js";

const issuer = "https://identity.example.com";
function oidcDraft() {
  return {
    ...identityConnectionDraft("byo-identity"),
    issuer,
    clientId: "spa",
    scope: "openid email",
  };
}
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
function testPage(search = ""): PagePort {
  return {
    location: {
      origin: "https://app.example.com",
      hostname: "app.example.com",
      host: "app.example.com",
      protocol: "https:",
      pathname: "/",
      href: "https://app.example.com/",
      search,
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

it("presets expose native session protocols and BYO composes every implemented protocol", () => {
  expect(identityConnectionDraft("better-auth").protocol).toBe("better-auth");
  expect(identityConnectionDraft("neon-auth").protocol).toBe("better-auth");
  expect(identityConnectionDraft("supabase").protocol).toBe("supabase");
  expect(identityConnectionDraft("clerk").protocol).toBe("oidc");
  expect(
    identityConnectionProblems({
      ...oidcDraft(),
      issuer: "https://user:pass@identity.example.com",
    }),
  ).toContain("Enter an HTTPS OIDC issuer URL");
});
it("discovery probes persist nothing and refuse issuer/endpoint/PKCE mismatches", async () => {
  expect((await testIdentityConnection(oidcDraft())).message).toContain(
    "Complete sign-in",
  );
  expect(readDeviceRows()).toEqual([]);
  expect(signInMethods().providers).toEqual([]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ ...discovery(), issuer: "https://attacker.example" }),
    ),
  );
  await expect(testIdentityConnection(oidcDraft())).rejects.toThrow(
    "does not match",
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        ...discovery(),
        token_endpoint: "https://attacker.example/token",
      }),
    ),
  );
  await expect(testIdentityConnection(oidcDraft())).rejects.toThrow(
    "must belong",
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        ...discovery(),
        code_challenge_methods_supported: ["plain"],
      }),
    ),
  );
  await expect(testIdentityConnection(oidcDraft())).rejects.toThrow("S256");
});
it("saved OIDC configuration reloads as pending, projects real unlock sign-in, and revocation removes its trust", async () => {
  const saved = await saveIdentityConnection(oidcDraft());
  expect(saved.status).toBe("pending");
  memory.clear();
  for (const [key, value] of disk) memory.set(key, value);
  expect(readIdentityConnection(saved.connectionId)?.issuer).toBe(issuer);
  expect(listIdentityConnections()[0]?.status).toBe("pending");
  const provider = signInMethods().providers[0];
  expect(provider?.connectionId).toBe(saved.connectionId);
  if (!provider) throw new Error("No projected provider");
  await beginSignIn(operatorUpstream(provider));
  const authorize = new URL(navigation[0] ?? "");
  expect(authorize.origin).toBe(issuer);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorize.searchParams.get("scope")).toBe("openid email");
  expect(authorize.searchParams.get("client_id")).toBe("spa");
  await revokeDeviceConnection(saved.connectionId);
  expect(readIdentityConnection(saved.connectionId)).toBeNull();
  expect(signInMethods().providers).toEqual([]);
});
it("sealed secrets never render, blank unchanged edits retain them, changed targets invalidate them", async () => {
  const privateDraft = { ...oidcDraft(), clientSecret: "confidential-secret" };
  const saved = await writeIdentityConnection(privateDraft);
  expect(readIdentityConnection(saved.connectionId)?.clientSecret).toBe("");
  expect(JSON.stringify(readDeviceRows())).not.toContain("confidential-secret");
  expect(getIdentityConnectionRuntime(saved.connectionId)?.clientSecret).toBe(
    "confidential-secret",
  );
  await writeIdentityConnection(
    { ...privateDraft, clientSecret: "", name: "Renamed" },
    saved.connectionId,
  );
  expect(readDeviceSecrets()[saved.connectionId]?.clientSecret).toBe(
    "confidential-secret",
  );
  await writeIdentityConnection(
    { ...privateDraft, issuer: "https://other.example.com", clientSecret: "" },
    saved.connectionId,
  );
  expect(getIdentityConnectionRuntime(saved.connectionId)?.clientSecret).toBe(
    "",
  );
});
it("failed encrypted persistence adds no trusted sign-in provider", async () => {
  vi.spyOn(kvSeams, "kvSetDurable").mockRejectedValueOnce(
    new Error("disk unavailable"),
  );
  await expect(saveIdentityConnection(oidcDraft())).rejects.toThrow(
    "disk unavailable",
  );
  expect(signInMethods().providers).toEqual([]);
});
it("configured OIDC completes a signed PKCE exchange and becomes active; tampered signatures are refused", async () => {
  const saved = await saveIdentityConnection(oidcDraft());
  const provider = signInMethods().providers[0];
  if (!provider) throw new Error("No projected provider");
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  let tamper = false;
  let badNonce = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url).endsWith("openid-configuration"))
        return Response.json({ ...discovery(), issuer: `${issuer}/` });
      if (String(url).endsWith("/jwks"))
        return Response.json({ keys: [{ ...jwk, kid: "key1", alg: "ES256" }] });
      const nonce = new URL(navigation.at(-1) ?? "").searchParams.get("nonce");
      const token = await new SignJWT({
        email: "person@example.com",
        nonce: badNonce ? "wrong-nonce" : nonce,
      })
        .setProtectedHeader({ alg: "ES256", kid: "key1" })
        .setIssuer(`${issuer}/`)
        .setAudience("spa")
        .setSubject("account-42")
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(privateKey);
      const parts = token.split(".");
      const returnedToken = tamper
        ? `${parts[0]}.${parts[1]}.${parts[2]?.startsWith("a") ? "b" : "a"}${parts[2]?.slice(1)}`
        : token;
      return Response.json({ id_token: returnedToken });
    }),
  );
  async function roundTrip() {
    if (!provider) throw new Error("No projected provider");
    await beginSignIn(operatorUpstream(provider));
    const auth = new URL(navigation.at(-1) ?? "");
    configureHost(
      createTestHost({
        page: testPage(`?code=code&state=${auth.searchParams.get("state")}`),
      }),
    );
    return completeSignIn();
  }
  const result = await roundTrip();
  expect(result?.identity.pairwiseSub).toBe("account-42");
  expect(loadSession()?.upstreamId).toBe(`identity:${saved.connectionId}`);
  expect(listIdentityConnections()[0]?.status).toBe("active");
  badNonce = true;
  await expect(roundTrip()).rejects.toThrow();
  badNonce = false;
  tamper = true;
  await expect(roundTrip()).rejects.toThrow();
  await removeIdentityConnection(saved.connectionId);
  expect(loadSession()).toBeNull();
});

it("rolls back a sealed create when the public sign-in method cannot persist", async () => {
  vi.spyOn(kvSeams, "kvSetDurable").mockImplementation(async (key, value) => {
    if (key === "settings.v1") throw new Error("settings persistence failed");
    disk.set(key, value);
    memory.set(key, value);
  });
  await expect(saveIdentityConnection(oidcDraft())).rejects.toThrow(
    "settings persistence failed",
  );
  expect(listIdentityConnections()).toEqual([]);
  expect(signInMethods().providers).toEqual([]);
});
it("separate saved native organizations remain cold-bound and never fall back to an owner API or broker redirect", async () => {
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
  await expect(
    beginIdentityConnectionSignIn(saved[1]?.connectionId ?? ""),
  ).rejects.toThrow("Enable Networking");
  expect(hydrate).not.toHaveBeenCalled();
  expect(navigation).toEqual([]);
  expect(list).not.toHaveBeenCalled();
});

it("rejects an off-origin returnTo before it can reach navigation", async () => {
  await expect(
    beginIdentityConnectionSignIn("missing-connection", {
      returnTo: "https://evil.example/steal",
    }),
  ).rejects.toThrow(/return address/i);
  await expect(
    beginIdentityConnectionSignIn("missing-connection", {
      returnTo: "//evil.example/steal",
    }),
  ).rejects.toThrow(/return address/i);
});
