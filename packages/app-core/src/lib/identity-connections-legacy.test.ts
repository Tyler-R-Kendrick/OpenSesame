import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import type { PagePort } from "../ports.js";
import { createTestHost } from "../test-host.js";
import { readFederationSessionJson } from "./federation-session-store.js";
import { completeSignIn, loadSession, saveSession } from "./federation.js";
import {
  beginIdentityConnectionSignIn,
  listIdentityConnections,
  readInitialIdentityDraft,
  saveIdentityConnection,
} from "./identity-connections.js";
import { kvForgetAll, kvSeams } from "./kv.js";
import {
  loadSettings,
  saveSettingsDurable,
  signInMethods,
} from "./settings.js";

const issuer = "https://tenant.auth0.com";
const legacy = {
  providerId: "auth0",
  issuer,
  clientId: "old-client",
  label: "Existing Auth0",
};
const workos = {
  providerId: "workos",
  issuer: "https://workos.example",
  clientId: "other-client",
  label: "Other provider",
};
const disk = new Map<string, string>();
const navigations: string[] = [];

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
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
function page(search = ""): PagePort {
  const port: PagePort = {
    location: {
      origin: "https://app.example.com",
      hostname: "app.example.com",
      host: "app.example.com",
      protocol: "https:",
      pathname: "/",
      href: `https://app.example.com/${search}`,
      search,
      hash: "",
      assign: (url) => {
        navigations.push(String(url));
      },
      replace: () => {},
      reload: () => {},
    },
    opener: null,
    isSecureContext: true,
    visibilityState: "visible",
    replaceUrl: (href) => {
      const next = new URL(href, port.location.href);
      Object.assign(port.location, {
        href: next.href,
        search: next.search,
        pathname: next.pathname,
        hash: next.hash,
      });
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    open: () => null,
    close: () => {},
    onVisibilityChange: () => () => {},
    startDownload: () => {},
    submitForm: () => {},
  };
  return port;
}
function discovery() {
  return {
    issuer: `${issuer}/`,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
  };
}
async function seedLegacy() {
  const current = loadSettings();
  await saveSettingsDurable({
    ...current,
    signIn: { ...signInMethods(current), providers: [legacy, workos] },
  });
}
beforeEach(async () => {
  disk.clear();
  navigations.length = 0;
  kvForgetAll();
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("sessionStorage", storage());
  configureHost(createTestHost({ page: page() }));
  vi.spyOn(kvSeams, "kvGet").mockImplementation((key) => disk.get(key) ?? null);
  vi.spyOn(kvSeams, "kvSetDurable").mockImplementation(async (key, value) => {
    disk.set(key, value);
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(discovery())),
  );
  await seedLegacy();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  configureHost(createTestHost());
});

it("edits legacy Auth0 into the shared ledger, preserves the other provider, and completes signed PKCE sign-in", async () => {
  const draft = readInitialIdentityDraft("auth0");
  expect(draft).toMatchObject({
    issuer,
    clientId: "old-client",
    name: "Existing Auth0",
    protocol: "oidc",
  });
  expect(listIdentityConnections()).toEqual([]);
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  const oldToken = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: "key1" })
    .setIssuer(`${issuer}/`)
    .setAudience("old-client")
    .setSubject("account-42")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
  saveSession({
    issuer: `${issuer}/`,
    audience: "old-client",
    upstreamId: `operator:${issuer}`,
    pairwiseSub: "account-42",
    jwksUri: `${issuer}/jwks`,
    idToken: oldToken,
    expiresAt: Date.now() + 600_000,
  });
  expect(loadSession()?.upstreamId).toBe(`operator:${issuer}`);
  const saved = await saveIdentityConnection({
    ...draft,
    clientId: "new-client",
    name: "Configured Auth0",
  });
  expect(readInitialIdentityDraft("auth0", saved.connectionId).clientId).toBe(
    "new-client",
  );
  expect(signInMethods().providers).toEqual([
    workos,
    expect.objectContaining({
      providerId: "auth0",
      connectionId: saved.connectionId,
      clientId: "new-client",
    }),
  ]);
  expect(readFederationSessionJson()).toBeNull();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      if (String(input).endsWith("openid-configuration"))
        return Response.json(discovery());
      if (String(input).endsWith("/jwks"))
        return Response.json({ keys: [{ ...jwk, kid: "key1", alg: "ES256" }] });
      const auth = new URL(navigations.at(-1) ?? "");
      const token = await new SignJWT({ nonce: auth.searchParams.get("nonce") })
        .setProtectedHeader({ alg: "ES256", kid: "key1" })
        .setIssuer(`${issuer}/`)
        .setAudience("new-client")
        .setSubject("account-42")
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(privateKey);
      return Response.json({ id_token: token });
    }),
  );
  await beginIdentityConnectionSignIn(saved.connectionId);
  const auth = new URL(navigations.at(-1) ?? "");
  expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
  expect(auth.searchParams.get("nonce")).toBeTruthy();
  configureHost(
    createTestHost({
      page: page(`?code=code&state=${auth.searchParams.get("state")}`),
    }),
  );
  expect((await completeSignIn())?.identity.pairwiseSub).toBe("account-42");
  expect(loadSession()?.upstreamId).toBe(`identity:${saved.connectionId}`);
  expect(listIdentityConnections()[0]?.status).toBe("active");
});

it("refuses another provider's issuer without stealing its trust or touching the legacy Auth0 entry", async () => {
  const draft = readInitialIdentityDraft("auth0");
  await expect(
    saveIdentityConnection({ ...draft, issuer: `${workos.issuer}/` }),
  ).rejects.toThrow("already configured");
  expect(signInMethods().providers).toEqual([legacy, workos]);
  expect(listIdentityConnections()).toEqual([]);
});

it("failed sealed or public trust writes retain the complete legacy projection", async () => {
  const draft = readInitialIdentityDraft("auth0");
  const durable = vi.spyOn(kvSeams, "kvSetDurable");
  durable.mockRejectedValueOnce(new Error("sealed disk unavailable"));
  await expect(saveIdentityConnection(draft)).rejects.toThrow(
    "sealed disk unavailable",
  );
  expect(signInMethods().providers).toEqual([legacy, workos]);
  durable.mockImplementation(async (key, value) => {
    if (key === "settings.v1") throw new Error("public trust unavailable");
    disk.set(key, value);
  });
  await expect(saveIdentityConnection(draft)).rejects.toThrow(
    "public trust unavailable",
  );
  expect(signInMethods().providers).toEqual([legacy, workos]);
  expect(listIdentityConnections()).toEqual([]);
});

it("a legacy edit made during discovery wins over the older migration snapshot", async () => {
  const draft = readInitialIdentityDraft("auth0");
  const changed = { ...legacy, clientId: "changed-by-other-tab" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const current = loadSettings();
      await saveSettingsDurable({
        ...current,
        signIn: { ...signInMethods(current), providers: [changed, workos] },
      });
      return Response.json(discovery());
    }),
  );
  await expect(saveIdentityConnection(draft)).rejects.toThrow(
    "changed; reload",
  );
  expect(signInMethods().providers).toEqual([changed, workos]);
  expect(listIdentityConnections()).toEqual([]);
});

it("does not select an arbitrary legacy entry or migrate one into a native protocol", async () => {
  const current = loadSettings();
  const another = {
    ...legacy,
    issuer: "https://second.auth0.com",
    clientId: "second-client",
  };
  await saveSettingsDurable({
    ...current,
    signIn: { ...signInMethods(current), providers: [legacy, another] },
  });
  expect(readInitialIdentityDraft("auth0").clientId).toBe("");
  await expect(
    saveIdentityConnection({
      ...readInitialIdentityDraft("auth0"),
      issuer,
      clientId: "spa",
    }),
  ).rejects.toThrow("Multiple legacy");
  expect(readInitialIdentityDraft("better-auth").protocol).toBe("better-auth");
  expect(readInitialIdentityDraft("better-auth").issuer).toBe("");
  expect(signInMethods().providers).toEqual([legacy, another]);
});
