/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://pwa.example.test/OpenSesame/"} */
import { expect, it, vi } from "vitest";
import { configureHost, host } from "../../host.js";
import { readNativeFederationSession } from "../../lib/federation-native-session.js";
import { readFederationSessionJson } from "../../lib/federation-session-store.js";
import { getIdentityConnectionRuntime } from "../../lib/identity-connections-store.js";
import { captureNativeIdentityOwner } from "../../lib/identity-native-owner.js";
import { fixture } from "../../lib/origin-file-publication-custody.test-support.js";
import { signInConfiguredNativeOidc } from "./configured-runtime.js";
import { hold, saveAdapter } from "./oidc.test-support.js";
import { tlsOracle } from "./tls.test-support.js";

it.each([false, true])(
  "original TLS token refusal awaits physical retirement before owner release (cleanup failure %s)",
  async (failCleanup) => {
    fixture();
    const current = host();
    configureHost({
      ...current,
      env: { ...current.env, BASE_URL: "/OpenSesame/" },
    });
    const idp = await tlsOracle("client_secret_basic", "both");
    const { connection } = await saveAdapter({
      ...idp,
      config: { ...idp.config, clientSecret: "wrong synthetic credential" },
    });
    const draft = getIdentityConnectionRuntime(connection.connectionId);
    if (!draft) throw new Error("Missing actual saved configuration");
    const owner = captureNativeIdentityOwner(connection.connectionId, "oidc");
    owner.bindConfiguration(draft);
    const events: string[] = [];
    owner.signal.addEventListener("abort", () => events.push("owner-release"));
    const unread = new Set<Response>();
    const transport = {
      ...idp.transport,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await idp.transport.fetch(input, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            Connection: "close",
          },
        });
        if (!response.ok) unread.add(response);
        return response;
      },
    };
    const started = hold();
    const release = hold();
    const cleanupFailure = new Error("Original physical retirement failed");
    const retire = vi.fn(async () => {
      events.push("retiring");
      started.resolve();
      await release.promise;
      await Promise.all(
        [...unread].map(async (response) => {
          await response.body?.cancel();
        }),
      );
      await vi.waitFor(() =>
        expect(idp.closed).toHaveLength(idp.requests.length),
      );
      events.push("drained");
      if (failCleanup) throw cleanupFailure;
    });
    const popup = {
      cancel: vi.fn(),
      wait: vi.fn(
        async (request: { authorizationUrl: string; state: string }) => {
          idp.authorize(request.authorizationUrl);
          return {
            state: request.state,
            code: "independent-once",
            error: false,
          };
        },
      ),
    };
    const operation = signInConfiguredNativeOidc(
      connection.connectionId,
      draft,
      owner,
      popup,
      transport,
      retire,
    );
    const settled = operation.then(
      () => undefined,
      (error) => error,
    );
    try {
      const first = await Promise.race([
        started.promise.then(() => "retiring"),
        settled.then(() => "settled"),
      ]);
      expect(first).toBe("retiring");
      expect(owner.signal.aborted).toBe(false);
      expect(events).toEqual(["retiring"]);
      expect(readNativeFederationSession()).toBeNull();
      expect(readFederationSessionJson()).toBeNull();
    } finally {
      release.resolve();
      await settled;
    }
    const error = await settled;
    if (failCleanup) {
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toMatchObject({
        errors: [
          expect.objectContaining({ message: "OIDC response refused" }),
          cleanupFailure,
        ],
      });
    } else {
      expect(error).toMatchObject({ message: "OIDC response refused" });
    }
    expect(events).toEqual(["retiring", "drained", "owner-release"]);
    expect(retire).toHaveBeenCalledOnce();
    expect(unread.size).toBe(1);
    expect([...unread].every((response) => response.bodyUsed)).toBe(true);
    expect(idp.requests.map((row) => row.path)).toEqual([
      "/issuer/.well-known/openid-configuration",
      "/issuer/token",
    ]);
    expect(idp.errors).toHaveLength(1);
    expect(readNativeFederationSession()).toBeNull();
    expect(readFederationSessionJson()).toBeNull();
  },
);
