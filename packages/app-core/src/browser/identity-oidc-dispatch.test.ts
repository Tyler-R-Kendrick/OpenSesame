/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://pwa.example.test/OpenSesame/"} */
// Native enrollment/window are controlled public ports; TLS, code, JOSE, custody and admission are real.
import { BroadcastChannel } from "node:worker_threads";
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, expect, it, vi } from "vitest";
import { configureHost, host } from "../host.js";
import { webLocksDouble } from "../lib/__tests__/web-locks-double.js";
import { forgetAtRestKeyForTest } from "../lib/at-rest/key.js";
import { advanceAuthGeneration } from "../lib/auth-generation.js";
import { SETTINGS_PERSIST_KEY } from "../lib/capability-connector-scope.js";
import { readNativeFederationSession } from "../lib/federation-native-session.js";
import { readFederationSessionJson } from "../lib/federation-session-store.js";
import {
  getIdentityConnectionRuntime,
  hydrateIdentityConnections,
  readIdentityConnection,
} from "../lib/identity-connections-store.js";
import {
  beginIdentityConnectionSignIn,
  identityConnectionDraft,
  listIdentityConnections,
  saveIdentityConnection,
  testIdentityConnection,
} from "../lib/identity-connections.js";
import { kvFlush, kvForgetAll, kvHydrate } from "../lib/kv.js";
import { fixture } from "../lib/origin-file-publication-custody.test-support.js";
import {
  loadSettings,
  saveSettingsDurable,
  signInMethods,
} from "../lib/settings.js";
import {
  type IdentityBrowserNode,
  bindIdentityBrowserNodeFactory,
} from "../lib/tailscale/browser-node-identity-port.js";
import type { TailscaleNodeSnapshot } from "../lib/tailscale/browser-node-port.js";
import * as nodeState from "../lib/tailscale/browser-node-store.js";
import { vaultStore } from "../lib/vault/store.js";
import { page } from "../ports.js";
import { nativeOidcPeering } from "./identity-oidc-dispatch.js";
import {
  captureNativeAuthCode,
  nativeAuthChannel,
  nativeAuthRandom,
} from "./native-auth-message.js";
import { tlsOracle } from "./oidc/tls.test-support.js";
import "./oidc/oidc.test-support.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
async function native() {
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
  const storage = fixture();
  const current = host();
  configureHost({
    ...current,
    env: { ...current.env, BASE_URL: "/OpenSesame/" },
  });
  const idp = await tlsOracle("client_secret_basic", "both");
  vi.stubGlobal("BroadcastChannel", BroadcastChannel);
  const browserFetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Browser egress bypass");
  });
  vi.spyOn(nodeState, "savedBrowserNodeConfiguration").mockReturnValue({
    hostname: "public-original",
    controlURL: "https://control.example.test",
    nativeHTTP: {
      version: 1,
      exitNodeID: "owned-exit",
      trustMode: "operator",
      operatorCAPEM: idp.operatorCA,
      targets: [idp.config.issuer, idp.tokenBase, idp.jwksBase].map(
        (value) => ({
          origin: new URL(value).origin,
          prefixes: ["127.0.0.0/8"],
        }),
      ),
    },
  });
  let captures = 0;
  let retired = 0;
  let failDrain = false;
  const release = bindIdentityBrowserNodeFactory((owner) => {
    captures++;
    const stop = new AbortController();
    let state: TailscaleNodeSnapshot = {
      status: "stopped",
      hostname: "",
      controlURL: "",
      authURL: "",
      addresses: [],
      peerCount: 0,
      failure: "",
    };
    const watchers = new Set<() => void>();
    const check = () => {
      owner.signal.throwIfAborted();
      owner.assertCurrent();
      stop.signal.throwIfAborted();
    };
    const update = (status: TailscaleNodeSnapshot["status"]) => {
      check();
      state = { ...state, status };
      for (const notify of watchers) notify();
    };
    const node: IdentityBrowserNode = {
      snapshot: () => state,
      subscribe: (notify) => {
        watchers.add(notify);
        return () => {
          watchers.delete(notify);
        };
      },
      start: () => update("login"),
      login: () => update("connected"),
      captureNativeHTTP: (signal) =>
        Object.freeze({
          signal: AbortSignal.any([signal, owner.signal, stop.signal]),
          assertCurrent: check,
          supportsNativeOrigin: idp.transport.supportsNativeOrigin,
          fetch: async (input, init) => {
            check();
            const response = await idp.transport.fetch(input, {
              ...init,
              headers: {
                ...Object.fromEntries(new Headers(init?.headers)),
                Connection: "close",
              },
            });
            try {
              check();
            } catch (error) {
              await response.body?.cancel();
              throw error;
            }
            return response;
          },
        }),
      stop: async () => {
        if (!stop.signal.aborted) {
          retired++;
          stop.abort();
        }
        await vi.waitFor(() =>
          expect(idp.closed.length).toBe(idp.requests.length),
        );
        return !failDrain;
      },
    };
    return node;
  });
  cleanups.push(release);
  const draft = {
    ...identityConnectionDraft("byo-identity"),
    name: "Owned native organization",
    issuer: idp.config.issuer,
    clientId: idp.config.clientId,
    clientSecret: idp.config.clientSecret,
    scope: idp.config.scope,
    organizationId: "org_actual",
    oidcClientType: "confidential" as const,
    brokerUrl: "",
  };
  return {
    storage,
    idp,
    draft,
    browserFetch,
    captures: () => captures,
    retired: () => retired,
    failDrain: () => {
      failDrain = true;
    },
  };
}
async function enroll<T>(run: () => Promise<T>): Promise<T> {
  const result = run();
  await vi.waitFor(() =>
    expect(nativeOidcPeering()?.state.status).toBe("login"),
  );
  nativeOidcPeering()?.node.login();
  return result;
}
function popup(idp: Awaited<ReturnType<typeof tlsOracle>>) {
  const channels: BroadcastChannel[] = [];
  const locations: string[] = [];
  const errors: unknown[] = [];
  let acknowledgements = 0;
  const close = vi.fn();
  const value = {
    opener: window,
    closed: false,
    close,
    location: {
      href: "about:blank",
      replace: (href: string) => {
        locations.push(href);
        idp.authorize(href);
        const authorization = new URL(href);
        const callback = new URL(
          authorization.searchParams.get("redirect_uri") ?? "",
        );
        callback.searchParams.set(
          "state",
          authorization.searchParams.get("state") ?? "",
        );
        callback.searchParams.set("code", "independent-once");
        const code = captureNativeAuthCode(callback);
        if (!code)
          throw new Error("Actual static callback parser refused code");
        void nativeAuthChannel(code.state)
          .then((name) => {
            const channel = new BroadcastChannel(name);
            channels.push(channel);
            channel.onmessage = () => {
              acknowledgements++;
              channel.close();
            };
            callback.search = "";
            channel.postMessage({
              kind: "authorization-code",
              redirectUri: callback.href,
              receipt: nativeAuthRandom(),
              ...code,
            });
          })
          .catch((error) => errors.push(error));
      },
    },
  };
  const open = vi
    .spyOn(page(), "open")
    .mockReturnValue(overlapCast<typeof value, Window>(value));
  cleanups.push(() => {
    for (const channel of channels) channel.close();
  });
  return {
    open,
    locations,
    errors,
    close,
    acknowledgements: () => acknowledgements,
  };
}
it("retires a legacy direct OIDC entry instead of colliding with its issuer", async () => {
  const f = await native();
  const current = loadSettings();
  const legacy = {
    providerId: f.draft.providerId,
    issuer: f.draft.issuer,
    clientId: "legacy-client",
    label: "Old direct sign-in",
  };
  await saveSettingsDurable({
    ...current,
    signIn: { ...signInMethods(current), providers: [legacy] },
  });
  const saved = await enroll(() => saveIdentityConnection(f.draft));
  expect(signInMethods().providers).toEqual([
    expect.objectContaining({
      providerId: f.draft.providerId,
      connectionId: saved.connectionId,
      nativeIdentity: true,
    }),
  ]);
});

it("Test/Save use real captured TLS without an Identity API and cold custody retains only native public trust", async () => {
  const f = await native();
  expect(
    (await enroll(() => testIdentityConnection(f.draft))).message,
  ).toContain("Sign in to verify");
  expect(listIdentityConnections()).toEqual([]);
  const saved = await enroll(() => saveIdentityConnection(f.draft));
  expect(saved.status).toBe("pending");
  expect(readIdentityConnection(saved.connectionId)?.clientSecret).toBe("");
  expect(JSON.stringify([...f.storage.files.values()])).not.toContain(
    f.draft.clientSecret,
  );
  await kvFlush();
  kvForgetAll();
  forgetAtRestKeyForTest();
  await kvHydrate([SETTINGS_PERSIST_KEY]);
  await hydrateIdentityConnections();
  expect(getIdentityConnectionRuntime(saved.connectionId)?.clientSecret).toBe(
    f.draft.clientSecret,
  );
  expect(readNativeFederationSession()).toBeNull();
  expect(readFederationSessionJson()).toBeNull();
  expect(f.retired()).toBe(2);
  expect(f.browserFetch).not.toHaveBeenCalled();
  expect(f.idp.errors).toEqual([]);
});
it("cold saved native sign-in captures its original window/factory before hydration and consumes the real callback/token/JWKS before local publication", async () => {
  const f = await native();
  const saved = await enroll(() => saveIdentityConnection(f.draft));
  await kvFlush();
  kvForgetAll();
  forgetAtRestKeyForTest();
  await kvHydrate([SETTINGS_PERSIST_KEY]);
  const browser = popup(f.idp);
  const before = vaultStore.getSnapshot();
  const operation = beginIdentityConnectionSignIn(saved.connectionId);
  expect(browser.open).toHaveBeenCalledTimes(1);
  expect(f.captures()).toBe(1);
  expect(browser.locations).toEqual([]);
  await vi.waitFor(() =>
    expect(nativeOidcPeering()?.state.status).toBe("login"),
  );
  expect(f.captures()).toBe(2);
  nativeOidcPeering()?.node.login();
  await operation;
  const identity = readNativeFederationSession();
  expect(identity).toMatchObject({
    assertionFormat: "native-oidc",
    issuer: f.draft.issuer,
    audience: f.draft.clientId,
    pairwiseSub: "owned-person",
    idToken: "",
    jwksUri: "",
  });
  expect(vaultStore.getSnapshot()).toBe(before);
  expect(f.retired()).toBe(2);
  expect(readFederationSessionJson()).toBeNull();
  expect(browser.locations).toHaveLength(1);
  const authorization = new URL(browser.locations[0] ?? "");
  expect(authorization.searchParams.get("organization")).toBe("org_actual");
  expect(authorization.searchParams.get("redirect_uri")).toBe(
    "https://pwa.example.test/OpenSesame/auth/native-connector.html",
  );
  await vi.waitFor(() => expect(browser.acknowledgements()).toBe(1));
  expect(browser.errors).toEqual([]);
  expect(f.idp.errors).toEqual([]);
  expect(f.browserFetch).not.toHaveBeenCalled();
});
it("post-close actor withdrawal never returns Saved or retains new public trust", async () => {
  const f = await native();
  let fired = false;
  const delivery = fixture((stream) => {
    const original = stream.close;
    stream.close = async () => {
      await original();
      if (
        !fired &&
        [...delivery.files.keys()].some((name) =>
          name.endsWith("opensesame.self-hosted-connectors.v1.json"),
        )
      ) {
        fired = true;
        advanceAuthGeneration();
      }
    };
  });
  await expect(enroll(() => saveIdentityConnection(f.draft))).rejects.toThrow(
    /authority changed/,
  );
  expect(fired).toBe(true);
  expect(listIdentityConnections()).toEqual([]);
  expect(signInMethods().providers).toEqual([]);
  expect(f.browserFetch).not.toHaveBeenCalled();
});
it("missing physical retirement acknowledgement refuses configuration publication", async () => {
  const f = await native();
  f.failDrain();
  await expect(enroll(() => saveIdentityConnection(f.draft))).rejects.toThrow(
    /physical drain/,
  );
  expect(listIdentityConnections()).toEqual([]);
  expect(readNativeFederationSession()).toBeNull();
  expect(f.browserFetch).not.toHaveBeenCalled();
});

it("original actor withdrawal at real token headers refuses body consumption and local identity", async () => {
  const f = await native();
  const saved = await enroll(() => saveIdentityConnection(f.draft));
  const browser = popup(f.idp);
  f.idp.beforeResponse(async (path) => {
    if (path.endsWith("/token")) advanceAuthGeneration();
  });
  await expect(
    enroll(() => beginIdentityConnectionSignIn(saved.connectionId)),
  ).rejects.toThrow(/changed|cancelled|ended/);
  expect(
    f.idp.requests.filter((row) => row.path.endsWith("/token")),
  ).toHaveLength(1);
  expect(f.idp.requests.some((row) => row.path.endsWith("/jwks"))).toBe(false);
  expect(readNativeFederationSession()).toBeNull();
  expect(readFederationSessionJson()).toBeNull();
  expect(f.retired()).toBe(2);
  expect(browser.close).toHaveBeenCalled();
  expect(f.browserFetch).not.toHaveBeenCalled();
});
