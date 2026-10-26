/** Controlled enrollment/window ports; independently signed real TLS and callback channel. */
import { BroadcastChannel } from "node:worker_threads";
import {
  captureNativeAuthCode,
  nativeAuthChannel,
  nativeAuthRandom,
} from "@opensesame/app-core/browser/native-auth-message.js";
import { tlsOracle } from "@opensesame/app-core/browser/oidc/tls.test-support.js";
import { configureHost, host } from "@opensesame/app-core/host.js";
import { webLocksDouble } from "@opensesame/app-core/lib/__tests__/web-locks-double.js";
import { identityConnectionDraft } from "@opensesame/app-core/lib/identity-connections.js";
import { fixture } from "@opensesame/app-core/lib/origin-file-publication-custody.test-support.js";
import {
  type IdentityBrowserNode,
  bindIdentityBrowserNodeFactory,
} from "@opensesame/app-core/lib/tailscale/browser-node-identity-port.js";
import type { TailscaleNodeSnapshot } from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import * as nodeState from "@opensesame/app-core/lib/tailscale/browser-node-store.js";
import { page } from "@opensesame/app-core/ports.js";
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, expect, vi } from "vitest";
import "@opensesame/app-core/browser/oidc/oidc.test-support.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
function nodeFactory(idp: Awaited<ReturnType<typeof tlsOracle>>) {
  const controls: (() => void)[] = [];
  let captures = 0;
  let retired = 0;
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
      start: (configuration) => {
        state = {
          ...state,
          controlURL: configuration.controlURL,
          hostname: "ephemeral-original",
        };
        update("login");
      },
      login: () => {
        state = {
          ...state,
          authURL: "https://control.example.test/register/original",
        };
        update("approval");
      },
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
        return true;
      },
    };
    controls.push(() => update("connected"));
    return node;
  });
  cleanups.push(release);
  return {
    captures: () => captures,
    retired: () => retired,
    approve: () => {
      const approve = controls.at(-1);
      if (!approve) throw new Error("No original node");
      approve();
    },
  };
}
export async function native() {
  vi.stubGlobal("navigator", { locks: webLocksDouble(), onLine: true });
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
  const control = nodeFactory(idp);
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
    ...control,
  };
}
export function popup(idp: Awaited<ReturnType<typeof tlsOracle>>) {
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
