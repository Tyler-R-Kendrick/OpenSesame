/**
 * The seams the setup ceremony's suites share (ADR 0114): settings kept in a
 * plain object so writes are assertions, the compiled-in broker as the
 * default upstream, and the ceremony's one network call (OIDC discovery) as
 * a mock. Create once per test file; `reset` per test.
 */

import { type Mock, vi } from "vitest";
import type { OidcDiscovery } from "../../lib/federation.js";
import { federationSeams } from "../../lib/federation.js";
import {
  type PagesSettings,
  type SignInMethods,
  defaultSignInMethods,
  settingsSeams,
} from "../../lib/settings.js";
import { setupScreenDependencies } from "../SetupScreen.js";
import { waysInDependencies } from "./WaysIn.js";

export type WrittenSettings = Pick<
  PagesSettings,
  "identityApi" | "hostApi" | "daemonApi"
> & { signIn: SignInMethods };

export type SetupOutcome = {
  ways: string[];
  service: boolean;
  joined?: boolean;
  skipped?: string[];
};

export type SetupSeams = {
  written: WrittenSettings;
  currentSettings: () => PagesSettings;
  discover: Mock<(issuer: string) => Promise<OidcDiscovery>>;
  completeSetup: Mock<(outcome: SetupOutcome) => Promise<void>>;
  reset: () => void;
};

// Captured before any stubbing: the harness's settings start from the real
// ones, with only the written fields overlaid.
const realLoadSettings = settingsSeams.loadSettings;

export function createSetupSeams(): SetupSeams {
  const written: WrittenSettings = {
    identityApi: "",
    hostApi: "",
    daemonApi: "",
    signIn: defaultSignInMethods(),
  };
  const currentSettings = (): PagesSettings => ({
    ...realLoadSettings(),
    ...written,
  });
  Object.assign(settingsSeams, {
    loadSettings: currentSettings,
    saveSettings: (next: PagesSettings) => {
      written.identityApi = next.identityApi;
      written.hostApi = next.hostApi;
      written.daemonApi = next.daemonApi;
      written.signIn = next.signIn ?? defaultSignInMethods();
    },
    pageIsLoopback: () => false,
  });
  Object.assign(federationSeams, {
    defaultUpstream: () => ({
      id: "shoo",
      displayName: "Shoo",
      issuer: "https://shoo.dev",
      accountKind: "Google",
    }),
  });
  const discover = vi.fn<(issuer: string) => Promise<OidcDiscovery>>();
  const completeSetup = vi.fn<(outcome: SetupOutcome) => Promise<void>>();
  const reset = () => {
    written.identityApi = "";
    written.hostApi = "";
    written.daemonApi = "";
    written.signIn = defaultSignInMethods();
    discover.mockReset();
    discover.mockResolvedValue({
      issuer: "https://acme.okta.com",
      authorization_endpoint: "https://acme.okta.com/authorize",
      token_endpoint: "https://acme.okta.com/token",
      jwks_uri: "https://acme.okta.com/keys",
    });
    completeSetup.mockReset();
    completeSetup.mockResolvedValue(undefined);
    Object.assign(waysInDependencies, {
      discover,
      redirectUri: () => "https://tyler-r-kendrick.github.io/OpenSesame/",
    });
    Object.assign(setupScreenDependencies, {
      completeSetup,
      loadSettings: currentSettings,
      readJoinFromLocation: () => null,
    });
  };
  return { written, currentSettings, discover, completeSetup, reset };
}
