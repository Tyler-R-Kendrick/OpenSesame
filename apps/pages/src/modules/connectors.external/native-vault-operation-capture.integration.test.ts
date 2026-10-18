/** @vitest-environment jsdom */
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
import { bindNativeOAuthBrowserPort } from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import {
  authorizationUrl,
  nonce,
  redirectUri,
  state,
  token,
  input as vaultInput,
} from "@opensesame/app-core/lib/native-vault.test-support.js";
import {
  deferred,
  runtimeFixture,
} from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import {
  type TailscaleBrowserNode,
  TailscaleNativeHTTPConfiguration,
  bindTailscaleBrowserNode,
} from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import {
  openBrowserNodeState,
  updateBrowserNodeNativeHTTP,
} from "@opensesame/app-core/lib/tailscale/browser-node-store.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nativeConnectorController } from "../../sections/connections/connect/native-connector-controller.js";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindNativeCleanupRuntime } from "./native-cleanup-runtime.js";
import { bindNativeRuntime } from "./native-runtime.js";
import { bindNativeVaultRuntime } from "./native-vault-runtime.js";

const input = {
  method: "oidc" as const,
  displayName: "Captured Vault OIDC",
  parameters: {
    endpoint: vaultInput.endpoint,
    namespace: vaultInput.namespace,
    auth_mount: vaultInput.authMount,
    role: vaultInput.role,
  },
  credentials: {},
  requestedScopes: {},
  targetIds: {},
};
let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
const releases: (() => void)[] = [];
beforeEach(async () => {
  fixture = await runtimeFixture();
});
afterEach(async () => {
  for (const release of releases.splice(0).reverse()) release();
  await fixture.close();
});
async function save() {
  return openBrowserNodeState(
    {
      hostname: "vault-browser",
      controlURL: "https://controlplane.tailscale.com",
      nativeHTTP: TailscaleNativeHTTPConfiguration.parse({
        version: 1,
        exitNodeID: "approved-exit",
        trustMode: "public",
        targets: [
          { origin: vaultInput.endpoint, prefixes: ["203.0.113.0/24"] },
        ],
      }),
    },
    vaultStore.getSnapshot().tomb,
    () => {
      if (!vaultStore.isUnlocked()) throw new Error("Vault locked");
    },
  );
}
async function answer(request: Request) {
  const url = new URL(request.url);
  if (url.origin !== vaultInput.endpoint)
    throw new Error("Wrong provider origin");
  expect(request.headers.get("x-vault-namespace")).toBe(vaultInput.namespace);
  if (url.pathname.endsWith("/oidc/auth_url")) {
    expect(request.method).toBe("POST");
    expect(await request.json()).toMatchObject({
      role: vaultInput.role,
      redirect_uri: redirectUri,
    });
    return Response.json({ data: { auth_url: authorizationUrl() } });
  }
  if (url.pathname.endsWith("/oidc/callback")) {
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.get("nonce")).toBe(nonce);
    expect(url.searchParams.get("code")).toBe("owned-authorization-code");
    expect(url.searchParams.get("client_nonce")).toMatch(/^[a-f0-9]{64}$/);
    return Response.json({
      auth: { client_token: token, lease_duration: 300 },
    });
  }
  expect(request.headers.get("x-vault-token")).toBe(token);
  if (url.pathname.endsWith("/lookup-self"))
    return Response.json({
      data: {
        entity_id: "owned-vault-entity",
        display_name: "Scoped OIDC user",
        policies: ["browser-read"],
        ttl: 300,
        renewable: true,
      },
    });
  if (url.pathname.endsWith("/revoke-self"))
    return new Response(null, { status: 204 });
  if (url.pathname === "/v1/secret/data/app/config")
    return Response.json({
      data: { data: { setting: "native-KV-secret" }, metadata: { version: 2 } },
    });
  throw new Error("Unexpected provider path");
}
function node() {
  const lifetime = new AbortController();
  let respond = answer;
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    lifetime.signal.throwIfAborted();
    init?.signal?.throwIfAborted();
    const request = new Request(input, init);
    requests.push(request.clone());
    const response = await respond(request);
    lifetime.signal.throwIfAborted();
    init?.signal?.throwIfAborted();
    return response;
  });
  const capture = vi.fn(() => ({
    fetch,
    signal: lifetime.signal,
    assertCurrent: () => lifetime.signal.throwIfAborted(),
  }));
  const value: TailscaleBrowserNode = {
    captureNativeHTTP: capture,
    snapshot: () => ({
      status: "connected",
      hostname: "vault-browser",
      controlURL: "https://controlplane.tailscale.com",
      authURL: "",
      addresses: ["100.64.0.3"],
      peerCount: 1,
      failure: "",
    }),
    subscribe: () => () => {},
    start: async () => {},
    stop: () => lifetime.abort(),
    forget: async () => {},
    login() {},
    get: async () => {
      throw new Error("No peer fixture");
    },
  };
  releases.push(bindTailscaleBrowserNode(value));
  return {
    fetch,
    capture,
    requests,
    respond: (next: typeof answer) => {
      respond = next;
    },
  };
}
function activate() {
  const context = createTestContext();
  const activation = createActivation(context.ctx, "connectors.external");
  bindNativeRuntime(context.ctx, activation);
  bindNativeVaultRuntime(activation);
  bindNativeCleanupRuntime(activation, ["vault", "openbao"]);
  releases.push(activation.dispose);
  const authorize = vi.fn(async (url: string) => {
    expect(new URL(url).origin).toBe("https://identity.example.org");
    return `?native_state=${state}&native_code=owned-authorization-code`;
  });
  releases.push(
    bindNativeOAuthBrowserPort({
      redirectUri,
      authorize,
      navigate: () => {
        throw new Error("No navigation fallback");
      },
      scrubCallback() {},
    }),
  );
  return { context, activation, authorize };
}
function controller(providerId = "vault") {
  return nativeConnectorController({ id: providerId, refused: false });
}
it.each(["vault", "openbao"])(
  "%s binds and configures before the node, then signs in, verifies, reads and revokes through one native route per action",
  async (providerId) => {
    const bound = activate();
    const browser = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No browser fallback"));
    const control = controller(providerId);
    await control.configure(input);
    await save();
    const native = node();
    await control.authorize().finally(() => {
      expect(bound.context.egressCalls).toEqual([]);
      expect(browser).not.toHaveBeenCalled();
    });
    const saved = control.load();
    expect(saved?.status).toBe("connected");
    expect(saved?.identity?.id).toBe("owned-vault-entity");
    expect(native.capture).toHaveBeenCalledTimes(1);
    expect(native.fetch).toHaveBeenCalledTimes(3);
    await control.verify();
    expect(
      await control.invoke("provider.secret.read", {
        mount: "secret",
        path: "app/config",
      }),
    ).toEqual({
      label: "Secret version 2",
      items: [
        { id: "setting", label: "setting", secretValue: "native-KV-secret" },
      ],
    });
    expect(native.capture).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(readDeviceRows())).not.toContain(token);
    expect([...fixture.files.values()].join()).not.toContain(token);
    await control.remove();
    expect(readNativeConnector(saved?.connectionId ?? "")).toBeNull();
    expect(
      native.requests.filter((r) =>
        new URL(r.url).pathname.endsWith("/revoke-self"),
      ),
    ).toHaveLength(1);
    expect(bound.context.egressCalls).toEqual([]);
    expect(browser).not.toHaveBeenCalled();
  },
);
it.each(["node", "route", "lease", "activation"])(
  "journals an already-issued token after %s withdrawal without adopting another route or publishing verified access",
  async (reason) => {
    const bound = activate();
    const control = controller();
    const configured = await control.configure(input);
    const stored = await save();
    const first = node();
    const entered = deferred<void>();
    const finish = deferred<Response>();
    first.respond(async (request) => {
      if (new URL(request.url).pathname.endsWith("/oidc/callback")) {
        entered.resolve();
        return finish.promise;
      }
      return answer(request);
    });
    const pending = control.authorize();
    const rejected = expect(pending).rejects.toThrow();
    await entered.promise;
    if (reason === "route") {
      const nativeHTTP = stored.record.nativeHTTP;
      if (!nativeHTTP) throw new Error("Missing native route");
      await updateBrowserNodeNativeHTTP(
        stored.record,
        { ...nativeHTTP, exitNodeID: "other-exit" },
        () => {},
      );
    } else if (reason === "lease") bound.context.abort();
    else if (reason === "activation") bound.activation.dispose();
    const second = reason === "node" || reason === "activation" ? node() : null;
    if (reason === "activation") activate();
    finish.resolve(
      Response.json({ auth: { client_token: token, lease_duration: 300 } }),
    );
    await rejected;
    expect(
      (second?.requests ?? []).map((request) => new URL(request.url).pathname),
    ).toEqual([]);
    const record = loadNativeConnectorRecord(configured.connectionId);
    expect(
      record?.privateState.recovery.some(
        (entry) => entry.grant?.accessToken === token,
      ),
    ).toBe(true);
    expect(record?.privateState.grants).toEqual({});
    expect(readNativeConnector(configured.connectionId)?.status).not.toBe(
      "connected",
    );
    if (second) expect(second.fetch).not.toHaveBeenCalled();
    expect(
      first.requests.some((request) =>
        new URL(request.url).pathname.endsWith("/revoke-self"),
      ),
    ).toBe(false);
    expect(
      first.requests.some((request) =>
        new URL(request.url).pathname.endsWith("/lookup-self"),
      ),
    ).toBe(false);
    expect(bound.context.egressCalls).toEqual([]);
    expect(JSON.stringify(readDeviceRows())).not.toContain(token);
  },
);
it("retains original cleanup and reauthorization ownership after a separate explicit verification uses the current node", async () => {
  const bound = activate();
  const control = controller();
  await control.configure(input);
  await save();
  const first = node();
  await control.authorize();
  const saved = control.load();
  if (!saved) throw new Error("Missing actual signed-in connection");
  const second = node();
  await control.verify();
  const calls = second.fetch.mock.calls.length;
  await expect(control.authorize()).rejects.toThrow();
  await expect(control.remove()).rejects.toThrow();
  await expect(control.remove()).rejects.toThrow();
  const record = loadNativeConnectorRecord(saved.connectionId);
  expect(JSON.stringify(record?.privateState)).toContain(token);
  expect(
    first.requests.filter((r) =>
      new URL(r.url).pathname.endsWith("/revoke-self"),
    ),
  ).toHaveLength(0);
  expect(second.fetch).toHaveBeenCalledTimes(calls);
  expect(bound.context.egressCalls).toEqual([]);
});
it.each([403, 200])(
  "does not activate a denied or malformed mint response (%s)",
  async (status) => {
    const bound = activate();
    const control = controller();
    await control.configure(input);
    await save();
    const native = node();
    native.respond(async (request) =>
      new URL(request.url).pathname.endsWith("/oidc/callback")
        ? Response.json(
            status === 403
              ? { errors: ["Denied"] }
              : { auth: { client_token: 0 } },
            { status },
          )
        : answer(request),
    );
    await expect(control.authorize()).rejects.toThrow();
    expect(control.load()?.status).not.toBe("connected");
    expect(
      native.requests.some((r) =>
        new URL(r.url).pathname.endsWith("/lookup-self"),
      ),
    ).toBe(false);
    expect(bound.context.egressCalls).toEqual([]);
  },
);

it("does not pin a failed pre-mint unavailable node into later grant cleanup", async () => {
  const bound = activate();
  const control = controller();
  await control.configure(input);
  await save();
  await expect(control.authorize()).rejects.toThrow();
  const native = node();
  await control.authorize();
  expect(control.load()?.status).toBe("connected");
  await control.remove();
  expect(
    native.requests.filter((request) =>
      new URL(request.url).pathname.endsWith("/revoke-self"),
    ),
  ).toHaveLength(1);
  expect(bound.context.egressCalls).toEqual([]);
});
