/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://pwa.example.test/OpenSesame/"} */
// Default HTTP/JOSE/admission are real; popup and OPFS remain explicit port doubles.
import { expect, it, vi } from "vitest";
import { advanceAuthGeneration } from "../lib/auth-generation.js";
import { readNativeFederationSession } from "../lib/federation-native-session.js";
import { readFederationSessionJson } from "../lib/federation-session-store.js";
import {
  beginIdentityConnectionSignIn,
  saveIdentityConnection,
  testIdentityConnection,
} from "../lib/identity-connections.js";
import { bindIdentityBrowserNodeFactory } from "../lib/tailscale/browser-node-identity-port.js";
import { vaultStore } from "../lib/vault/store.js";
import { nativeOidcPeering } from "./identity-oidc-dispatch.js";
import * as browserHTTP from "./oidc/browser-transport.js";
import {
  popup,
  publicContext,
  track,
} from "./oidc/public-browser.test-support.js";

it.each(["manual", "organization"] as const)(
  "the default %s public consumer verifies actual HTTP evidence without a node factory",
  async (mode) => {
    const { wire, draft } = await publicContext();
    const selected = { ...draft };
    if (mode === "manual") {
      selected.oidcAuthorizationEndpoint = `${wire.issuer}/authorize`;
      selected.oidcTokenEndpoint = `${wire.issuer}/token`;
      selected.jwksUri = `${wire.issuer}/jwks`;
    }
    if (mode === "organization") selected.organizationId = "org_public";
    const result = await testIdentityConnection(selected);
    expect(result.message).toContain("Sign in to verify");
    expect(wire.requests).not.toContain("/token");
    const saved = await saveIdentityConnection(selected);
    const before = vaultStore.getSnapshot();
    const browser = popup(wire);
    await beginIdentityConnectionSignIn(saved.connectionId);
    expect(nativeOidcPeering()).toBeNull();
    expect(readNativeFederationSession()).toMatchObject({
      issuer: wire.issuer,
      audience: draft.clientId,
      pairwiseSub: "browser-person",
      idToken: "",
      jwksUri: "",
    });
    expect(readFederationSessionJson()).toBeNull();
    expect(vaultStore.getSnapshot()).toBe(before);
    expect(wire.requests).toContain("/token");
    expect(browser.errors).toEqual([]);
  },
);

it("public configuration does not construct even an installed unrelated native factory", async () => {
  const { draft } = await publicContext();
  const factory = vi.fn(() => {
    throw new Error("Unrelated native factory must not run");
  });
  track(bindIdentityBrowserNodeFactory(factory));
  await saveIdentityConnection(draft);
  expect(factory).not.toHaveBeenCalled();
  expect(nativeOidcPeering()).toBeNull();
});

it.each(["nonce", "organization"] as const)(
  "real %s claim refusal cannot become an admitted public identity",
  async (fault) => {
    const { wire, draft } = await publicContext();
    const saved = await saveIdentityConnection({
      ...draft,
      organizationId: "org_public",
    });
    wire.fault = fault;
    popup(wire);
    await expect(
      beginIdentityConnectionSignIn(saved.connectionId),
    ).rejects.toThrow(/nonce|organization/);
    expect(readNativeFederationSession()).toBeNull();
    expect(readFederationSessionJson()).toBeNull();
  },
);

it("original actor withdrawal at actual public token response refuses admission", async () => {
  const { wire, draft } = await publicContext();
  const saved = await saveIdentityConnection(draft);
  wire.beforeToken = () => {
    advanceAuthGeneration();
  };
  popup(wire);
  await expect(
    beginIdentityConnectionSignIn(saved.connectionId),
  ).rejects.toThrow(/changed|cancelled|ended|aborted/);
  expect(wire.requests).toContain("/token");
  expect(readNativeFederationSession()).toBeNull();
  expect(readFederationSessionJson()).toBeNull();
});

it.each([false, true])(
  "actual public token HTTP refusal retains its original error and physical cleanup failure (%s)",
  async (failCleanup) => {
    const { wire, draft } = await publicContext();
    const saved = await saveIdentityConnection(draft);
    wire.beforeToken = () => {
      throw new Error("Independent public token endpoint refusal");
    };
    popup(wire);
    const cleanupFailure = new Error("Original public carrier cleanup failed");
    const physical = new Set<Promise<void>>();
    const signals: AbortSignal[] = [];
    const capture = browserHTTP.captureBrowserOidcHTTP;
    const observation = vi
      .spyOn(browserHTTP, "captureBrowserOidcHTTP")
      .mockImplementation((owner) => {
        const actual = capture(owner);
        signals.push(actual.transport.signal);
        let retirement: Promise<void> | null = null;
        return Object.freeze({
          transport: actual.transport,
          retire: () => {
            if (retirement) return retirement;
            let begin = () => {};
            retirement = new Promise<void>((resolve, reject) => {
              begin = () => {
                const drain = actual.retire();
                physical.add(drain);
                void drain.then(() => {
                  if (failCleanup) reject(cleanupFailure);
                  else resolve();
                }, reject);
              };
            });
            begin();
            return retirement;
          },
        });
      });
    try {
      const operation = beginIdentityConnectionSignIn(saved.connectionId);
      if (failCleanup) {
        await expect(operation).rejects.toMatchObject({
          errors: [
            expect.objectContaining({ message: "OIDC response refused" }),
            cleanupFailure,
          ],
        });
      } else {
        await expect(operation).rejects.toThrow("OIDC response refused");
      }
      expect(physical.size).toBe(1);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
      expect(wire.requests).toContain("/token");
      expect(readNativeFederationSession()).toBeNull();
      expect(readFederationSessionJson()).toBeNull();
      expect(nativeOidcPeering()).toBeNull();
    } finally {
      observation.mockRestore();
    }
  },
);
