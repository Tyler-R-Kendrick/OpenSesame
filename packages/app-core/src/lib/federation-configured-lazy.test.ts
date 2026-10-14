import { afterEach, expect, it, vi } from "vitest";
import {
  type NativeRestorationRuntime,
  configuredIdentityLazySeams,
  restoreConfiguredIdentityAtBootIfPresent,
  restoreConfiguredIdentityIfNative,
} from "./federation-configured-lazy.js";
import * as sessionStore from "./federation-session-store.js";
import { loadSettings, settingsSeams } from "./settings.js";
const runtime: NativeRestorationRuntime = {
  restoreConfiguredIdentityAtBoot: async () => {},
  restoreConfiguredIdentitySession: async () => ({
    kind: "rejected",
    reason: "revoked",
  }),
};
afterEach(() => vi.restoreAllMocks());

it("ordinary and OIDC startup never imports the native identity graph", async () => {
  const load = vi
    .spyOn(configuredIdentityLazySeams, "load")
    .mockResolvedValue(runtime);
  const current = loadSettings();
  vi.spyOn(settingsSeams, "loadSettings").mockReturnValue({
    ...current,
    signIn: {
      builtin: true,
      providers: [
        {
          providerId: "auth0",
          protocol: "oidc",
          connectionId: "oidc",
          issuer: "https://issuer.example.com",
          clientId: "spa",
          label: "OIDC",
        },
      ],
    },
  });
  const read = vi.spyOn(sessionStore, "readFederationSessionJson");
  for (const raw of [
    null,
    "invalid",
    "null",
    JSON.stringify({ upstreamId: "shoo" }),
    JSON.stringify({ upstreamId: "identity:oidc" }),
  ]) {
    read.mockReturnValue(raw);
    restoreConfiguredIdentityAtBootIfPresent();
  }
  expect(
    await restoreConfiguredIdentityIfNative(
      { upstreamId: "identity:oidc", idToken: "token" },
      {
        issuer: "https://issuer.example.com",
        clientId: "spa",
        jwksUri: "https://issuer.example.com/jwks",
      },
    ),
  ).toBeNull();
  await Promise.resolve();
  expect(load).not.toHaveBeenCalled();
});
it("a saved native identity loads its validator lazily without blocking boot", async () => {
  const load = vi
    .spyOn(configuredIdentityLazySeams, "load")
    .mockResolvedValue(runtime);
  const boot = vi.spyOn(runtime, "restoreConfiguredIdentityAtBoot");
  const current = loadSettings();
  vi.spyOn(settingsSeams, "loadSettings").mockReturnValue({
    ...current,
    signIn: {
      builtin: true,
      providers: [
        {
          providerId: "better-auth",
          protocol: "better-auth",
          connectionId: "native",
          issuer: "https://issuer.example.com",
          clientId: "spa",
          label: "Native",
        },
      ],
    },
  });
  vi.spyOn(sessionStore, "readFederationSessionJson").mockReturnValue(
    JSON.stringify({ upstreamId: "identity:native" }),
  );
  expect(restoreConfiguredIdentityAtBootIfPresent()).toBeUndefined();
  await vi.waitFor(() => expect(boot).toHaveBeenCalledOnce());
  expect(load).toHaveBeenCalledOnce();
});
