import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { authOutcomeSeams } from "./auth-outcome.js";
import { restoreConfiguredIdentityAtBoot } from "./federation-configured-restoration.js";
import {
  readFederationSessionJson,
  writeFederationSessionJson,
} from "./federation-session-store.js";
import { loadSession, saveSession } from "./federation.js";
import { guestAuthSeams } from "./guest-auth.js";
import {
  logoutIdentitySession,
  signInIdentitySession,
} from "./identity-connections-session.js";
import {
  betterAuthFixture,
  email,
  password,
  supabaseFixture,
} from "./identity-connections-session.test-support.js";
import { writeIdentityConnection } from "./identity-connections-store.js";
import {
  beginIdentityConnectionSignIn,
  identityConnectionDraft,
  saveIdentityConnection,
} from "./identity-connections.js";
import { kvSeams } from "./kv.js";
import { loadSettings, saveSettingsDurable } from "./settings.js";

const memory = new Map<string, string>();
const disk = new Map<string, string>();
const storage = new Map<string, string>();
beforeEach(() => {
  memory.clear();
  disk.clear();
  storage.clear();
  configureHost(
    createTestHost({
      storage: {
        local: {
          get length() {
            return storage.size;
          },
          key: (i) => [...storage.keys()][i] ?? null,
          getItem: (key) => storage.get(key) ?? null,
          setItem: (key, value) => {
            storage.set(key, value);
          },
          removeItem: (key) => {
            storage.delete(key);
          },
        },
      },
    }),
  );
  vi.spyOn(kvSeams, "kvGet").mockImplementation(
    (key) => memory.get(key) ?? null,
  );
  vi.spyOn(kvSeams, "kvSetDurable").mockImplementation(async (key, value) => {
    disk.set(key, value);
    memory.set(key, value);
  });
  vi.spyOn(kvSeams, "kvHydrate").mockImplementation(async (keys) => {
    for (const key of keys) {
      const value = disk.get(key);
      if (value) memory.set(key, value);
    }
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  configureHost(createTestHost());
});

it("a cold Better Auth reload hydrates its saved adapter, verifies a real cookie, and rejects a revoked cookie", async () => {
  const fixture = await betterAuthFixture();
  const draft = {
    ...identityConnectionDraft("better-auth"),
    baseUrl: `${fixture.baseURL}/api/auth`,
  };
  const connection = await saveIdentityConnection(draft);
  const identity = await signInIdentitySession(draft, { email, password });
  identity.upstreamId = `identity:${connection.connectionId}`;
  saveSession(identity);
  memory.clear();
  memory.set("settings.v1", disk.get("settings.v1") ?? "");
  await restoreConfiguredIdentityAtBoot();
  expect(loadSession()?.pairwiseSub).toBe(identity.pairwiseSub);
  expect(
    fixture.requests.filter((request) =>
      request.url.includes("/get-session?disableCookieCache=true"),
    ).length,
  ).toBeGreaterThan(1);
  await logoutIdentitySession(draft);
  await restoreConfiguredIdentityAtBoot();
  expect(readFederationSessionJson()).toBeNull();
});
it("legacy Supabase HS256 reloads authenticate through the live user endpoint and cannot switch subjects", async () => {
  const fixture = await supabaseFixture({ legacy: true });
  const connection = await saveIdentityConnection(fixture.draft);
  const identity = await signInIdentitySession(fixture.draft, {
    email,
    password,
  });
  identity.upstreamId = `identity:${connection.connectionId}`;
  saveSession(identity);
  memory.clear();
  memory.set("settings.v1", disk.get("settings.v1") ?? "");
  await restoreConfiguredIdentityAtBoot();
  expect(loadSession()?.pairwiseSub).toBe("supabase-user");
  expect(
    fixture.requests.filter((request) => request.url.endsWith("/user")).length,
  ).toBe(2);
  const originalFetch = fetch;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) =>
    url.endsWith("/user")
      ? Response.json({ id: "different-user" })
      : originalFetch(url, init),
  );
  await restoreConfiguredIdentityAtBoot();
  expect(loadSession()).toBeNull();
});
it("offline revalidation keeps the previously signed snapshot and does not create a replacement identity", async () => {
  const fixture = await supabaseFixture();
  const connection = await saveIdentityConnection(fixture.draft);
  const identity = await signInIdentitySession(fixture.draft, {
    email,
    password,
  });
  identity.upstreamId = `identity:${connection.connectionId}`;
  saveSession(identity);
  const raw = readFederationSessionJson();
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("offline");
  });
  await restoreConfiguredIdentityAtBoot();
  expect(readFederationSessionJson()).toBe(raw);
});
it("changed public audience and malformed sealed adapter data cannot retain a configured active session", async () => {
  const fixture = await supabaseFixture();
  const connection = await saveIdentityConnection(fixture.draft);
  const identity = await signInIdentitySession(fixture.draft, {
    email,
    password,
  });
  identity.upstreamId = `identity:${connection.connectionId}`;
  saveSession(identity);
  const settings = loadSettings();
  await saveSettingsDurable({
    ...settings,
    signIn: {
      builtin: true,
      providers: (settings.signIn?.providers ?? []).map((provider) => ({
        ...provider,
        clientId: "new-audience",
      })),
    },
  });
  expect(loadSession()).toBeNull();
  saveSession(identity);
  memory.set("opensesame.self-hosted-connectors.v1", "invalid-json");
  disk.set("opensesame.self-hosted-connectors.v1", "invalid-json");
  await restoreConfiguredIdentityAtBoot();
  expect(readFederationSessionJson()).toBeNull();
  writeFederationSessionJson("null");
  await expect(restoreConfiguredIdentityAtBoot()).resolves.toBeUndefined();
});

it("a cold native credential ceremony records verified sign-in and leaves a locked vault for its own unlock key", async () => {
  const fixture = await betterAuthFixture();
  const draft = {
    ...identityConnectionDraft("better-auth"),
    baseUrl: `${fixture.baseURL}/api/auth`,
  };
  const connection = await saveIdentityConnection(draft);
  const adopt = vi
    .spyOn(guestAuthSeams, "adoptFederatedIdentity")
    .mockResolvedValue({ kind: "local" });
  const open = vi
    .spyOn(guestAuthSeams, "openVaultAfterSignIn")
    .mockResolvedValue(false);
  const outcome = vi
    .spyOn(authOutcomeSeams, "storeAuthOutcome")
    .mockImplementation(() => {});
  memory.clear();
  memory.set("settings.v1", disk.get("settings.v1") ?? "");
  await beginIdentityConnectionSignIn(connection.connectionId, {
    credentials: { email, password },
  });
  expect(adopt).toHaveBeenCalledWith(loadSession()?.idToken);
  expect(open).toHaveBeenCalledOnce();
  expect(outcome).toHaveBeenCalledWith({
    kind: "linked",
    who: "Identity User",
  });
  expect(loadSession()?.upstreamId).toBe(`identity:${connection.connectionId}`);
});
it("a connection edited during native authentication cannot adopt the stale provider response", async () => {
  const fixture = await betterAuthFixture();
  const draft = {
    ...identityConnectionDraft("better-auth"),
    baseUrl: `${fixture.baseURL}/api/auth`,
  };
  const connection = await saveIdentityConnection(draft);
  const adopt = vi
    .spyOn(guestAuthSeams, "adoptFederatedIdentity")
    .mockResolvedValue({ kind: "local" });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const response = await fixture.fetchMock(url, init);
    if (url.endsWith("/token"))
      await writeIdentityConnection(
        { ...draft, baseUrl: "https://replacement.example.com/api/auth" },
        connection.connectionId,
      );
    return response;
  });
  await expect(
    beginIdentityConnectionSignIn(connection.connectionId, {
      credentials: { email, password },
    }),
  ).rejects.toThrow("configuration changed");
  expect(adopt).not.toHaveBeenCalled();
  expect(loadSession()).toBeNull();
});
