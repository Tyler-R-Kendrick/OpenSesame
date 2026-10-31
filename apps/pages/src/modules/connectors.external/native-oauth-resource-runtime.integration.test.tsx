/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://opensesame.example.test"} */
import { NATIVE_PROVIDER_PURPOSE } from "@opensesame/app-core/lib/capabilities/catalog-always-on.js";
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { nativeDeviceViewSeams } from "@opensesame/app-core/lib/device-connector-view.js";
import { nativeBrowserOAuthProfile } from "@opensesame/app-core/lib/native-browser-oauth-profile.js";
import {
  hasNativeConnectorDriver,
  nativeConnectorDriver,
} from "@opensesame/app-core/lib/native-connector-drivers.js";
import { registerNativeProviderCleanup } from "@opensesame/app-core/lib/native-connector-lifecycle.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import {
  type NativeProviderTransport,
  bindNativeProviderTransport,
} from "@opensesame/app-core/lib/native-connector-transport.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { bindNativeOAuthBrowserPort } from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import {
  type ClientMethod,
  nativeOAuthClientFixture,
} from "@opensesame/app-core/lib/native-oauth-client.test-support.js";
import { runtimePassword } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { NativeConnectorForm } from "../../sections/connections/connect/NativeConnectorForm.js";
import { nativeConnectorController } from "../../sections/connections/connect/native-connector-controller.js";
import { nativeInitialValues } from "../../sections/connections/connect/native-connector-edit-values.js";
import { nativeFieldValues } from "../../sections/connections/connect/native-connector-ui-values.js";
import { nativeProviderDescriptor } from "../../sections/connections/connect/native-provider-descriptor.js";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { nativeOAuthClientConfigured } from "./native-oauth-resource-runtime.js";
import {
  bindNativeOAuthRuntime,
  nativeCallbackUrl,
} from "./native-oauth-runtime.js";
import { bindNativeRuntime } from "./native-runtime.js";
const closes: (() => void | Promise<void>)[] = [];
const operations: Promise<unknown>[] = [];
afterEach(async () => {
  cleanup();
  for (const close of closes.splice(0).reverse()) await close();
  await Promise.allSettled(operations.splice(0));
});
async function setup(id = "box", auth: ClientMethod = "client_secret_post") {
  const f = await nativeOAuthClientFixture(auth);
  closes.push(f.close);
  f.input.providerId = id;
  f.state.redirectUri = nativeCallbackUrl();
  const test = createTestContext();
  const ctx = {
    ...test.ctx,
    egress: {
      ...test.ctx.egress,
      fetch: async (
        input: Parameters<typeof fetch>[0],
        init?: RequestInit,
        meta?: { capability: string; purpose: string },
      ) => {
        expect(meta).toEqual({
          capability: "connectors.external",
          purpose: NATIVE_PROVIDER_PURPOSE,
        });
        return f.owner.transport.fetch(input, init);
      },
    },
  };
  const activation = createActivation(ctx, "connectors.external");
  bindNativeRuntime(ctx, activation);
  const lifetime = new AbortController();
  let [route, captures] = [new AbortController(), 0];
  const carrierSignal = AbortSignal.any([f.controller.signal, lifetime.signal]);
  const fetchOriginal: typeof fetch = (input, init) =>
    ctx.egress.fetch(input, init, {
      capability: "connectors.external",
      purpose: NATIVE_PROVIDER_PURPOSE,
    });
  const carrier: NativeProviderTransport = {
    ...f.owner.transport,
    fetch: fetchOriginal,
    settleCredentialMutation: fetchOriginal,
    signal: carrierSignal,
    assertCurrent: () => {
      f.owner.transport.assertCurrent();
      if (activation.disposed()) throw new Error("Original activation ended");
    },
    capture: () => {
      captures++;
      const original = route;
      const signal = AbortSignal.any([carrierSignal, original.signal]);
      return {
        ...carrier,
        capture: undefined,
        signal,
        supportsNativeOrigin: (origin: string) => {
          signal.throwIfAborted();
          return origin === new URL(f.state.resource).origin;
        },
        assertCurrent: () => {
          carrier.assertCurrent();
          signal.throwIfAborted();
          if (original !== route) throw new Error("Original route changed");
        },
      };
    },
  };
  const releaseCarrier = bindNativeProviderTransport(carrier);
  activation.onDispose(() => {
    lifetime.abort();
    releaseCarrier();
  });
  bindNativeOAuthRuntime(activation);
  closes.push(activation.dispose);
  let cancelled = false;
  closes.push(
    bindNativeOAuthBrowserPort({
      redirectUri: f.state.redirectUri,
      navigate: () => {
        throw new Error("Unexpected navigation");
      },
      scrubCallback: () => {},
      authorize: async (url) => {
        if (cancelled) throw new Error("Operator cancelled consent");
        const target = new URL(url);
        f.state.challenge = target.searchParams.get("code_challenge") ?? "";
        f.state.scope = target.searchParams.get("scope") ?? "";
        return new URLSearchParams({
          native_state: target.searchParams.get("state") ?? "",
          native_code: "one-use-code",
        }).toString();
      },
    }),
  );
  const driver = nativeConnectorDriver("oauth", id);
  closes.push(registerNativeProviderCleanup(id, driver.cleanup));
  return {
    ...f,
    activation,
    driver,
    controller: nativeConnectorController({ id, refused: false }),
    captures: () => captures,
    paths: () => f.requests.map((row) => row.path),
    replaceRoute: () => {
      const old = route;
      route = new AbortController();
      old.abort();
    },
    cancel: () => {
      cancelled = true;
    },
  };
}
it("mounts real configured OAuth alongside mature profiles and reads actual HTTPS project JSON through the common controller", async () => {
  const f = await setup();
  expect(hasNativeConnectorDriver("oauth", "google")).toBe(true);
  expect(hasNativeConnectorDriver("oauth", "box")).toBe(true);
  const connected = await f.controller.connect(f.input);
  expect(connected.status).toBe("connected");
  const result = await f.controller.invoke("provider.resource.read", {});
  expect(JSON.parse(result.items[0]?.secretValue ?? "null")).toEqual({
    projects: [{ id: "project-42", name: "Actual configured project" }],
  });
  expect(f.paths()).toEqual(["/token", "/resource", "/resource"]);
  expect(f.requests[1]?.authorization).toBe("Bearer issued-access-1");
  await expect(f.controller.invoke("provider.read", {})).rejects.toThrow();
  f.controller.load();
  await f.controller.remove();
  expect(f.controller.load()).toBeNull();
});
it("corrects a definitive bad client then performs fresh consent and real resource read", async () => {
  const f = await setup();
  await expect(
    f.controller.connect({
      ...f.input,
      credentials: { client_secret: "incorrect-operator-client-secret" },
    }),
  ).rejects.toThrow();
  expect(f.controller.load()?.status).toBe("configuration");
  const connected = await f.controller.connect(f.input);
  expect(connected.status).toBe("connected");
  expect(f.paths()).toEqual(["/token", "/token", "/resource"]);
});
it("cancellation neither exchanges a code nor declares a resource successful", async () => {
  const f = await setup();
  f.cancel();
  await expect(f.controller.connect(f.input)).rejects.toThrow("cancelled");
  expect(f.requests).toEqual([]);
  expect(f.controller.load()?.status).toBe("configuration");
});
it("rejects a late real resource after lock and same-tomb unlock without adopting the fresh session", async () => {
  const f = await setup();
  f.state.holdResource = true;
  const operation = f.controller.connect(f.input);
  const rejected = expect(operation).rejects.toThrow();
  operations.push(rejected);
  await f.entered.promise;
  vaultStore.lock();
  await vaultStore.unlock(runtimePassword);
  f.release.resolve();
  await rejected;
  expect(f.controller.load()?.status).not.toBe("connected");
  expect(f.paths()).toEqual(["/token", "/resource"]);
});
it("rotating the exact resource invalidates the saved grant before any request to the new target", async () => {
  const f = await setup();
  const connected = await f.controller.connect(f.input);
  const count = f.requests.length;
  await expect(
    f.controller.configure({
      ...f.input,
      parameters: {
        ...f.input.parameters,
        resource: `${f.state.resource}/changed`,
      },
      credentials: {},
    }),
  ).rejects.toThrow();
  expect(f.requests).toHaveLength(count);
  expect(
    readNativeConnector(connected.connectionId)?.configuration.parameters
      .resource,
  ).toBe(f.state.resource);
  f.activation.dispose();
  await expect(
    f.driver.invoke(connected.connectionId, "provider.resource.read", {}),
  ).rejects.toThrow();
  expect(f.requests).toHaveLength(count);
});
it.each([
  { id: "box", auth: "client_secret_post" },
  { id: "resend", auth: "none" },
  { id: "resend", auth: "client_secret_basic" },
  { id: "resend", auth: "client_secret_post" },
  { id: "workos", auth: "none" },
  { id: "workos", auth: "client_secret_basic" },
  { id: "workos", auth: "client_secret_post" },
] as const)(
  "mounted $id $auth form connects only after actual token/resource TLS",
  async ({ id, auth }) => {
    const f = await setup(id, auth);
    if (id === "box") f.state.resourceParameter = "omit"; // ADR 0218
    const plan = connectPlan(id);
    if (!plan) throw new Error("Missing compiled native OAuth contract");
    const profile = nativeBrowserOAuthProfile(id);
    const descriptor = nativeProviderDescriptor(plan, {
      callbackUrl: nativeCallbackUrl(),
      apiKey: { available: false },
      oauth: { available: true, profile: profile ?? undefined },
      mcp: { available: false, actor: "user" },
    });
    const method = descriptor.methods.find((row) => row.id === "oauth");
    if (!method) throw new Error("Missing configured form");
    const views: NativeConnectorView[] = [];
    render(
      <NativeConnectorForm
        descriptor={{ ...descriptor, methods: [method] }}
        controller={f.controller}
        onChanged={(view) => {
          if (view) views.push(view);
        }}
        onFlash={() => {}}
      />,
    );
    if (profile?.mode === "cimd")
      fireEvent.change(screen.getByLabelText("OAuth application"), {
        target: { value: auth },
      });
    for (const [label, key] of [
      ["OAuth client ID", "client_id"],
      ["OAuth issuer URL", "issuer"],
      ["Authorization endpoint", "authorization_endpoint"],
      ["Token endpoint", "token_endpoint"],
      ["API resource URL", "resource"],
    ] as const) {
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: f.input.parameters[key] },
      });
    }
    if (!profile)
      fireEvent.change(screen.getByLabelText("Token endpoint authentication"), {
        target: { value: auth },
      });
    const secret = screen.queryByLabelText("OAuth client secret", {
      selector: 'input[type="password"]',
    });
    if (secret)
      fireEvent.change(secret, {
        target: { value: f.input.credentials.client_secret },
      });
    expect(f.requests).toEqual([]);
    fireEvent.click(
      screen.getByRole("button", { name: `Sign in to ${plan.name}` }),
    );
    await waitFor(() => expect(views.at(-1)?.status).toBe("connected"));
    expect(f.paths()).toEqual(["/token", "/resource"]);
    if (secret) expect(secret).toHaveProperty("value", "");
    if (auth !== "none")
      expect(JSON.stringify(views)).not.toContain(
        f.input.credentials.client_secret,
      );
    const tokens = vaultStore.getSnapshot().items;
    expect(
      tokens.some(
        (item) =>
          item.kind === "credential" &&
          item.method.type === "token" &&
          item.method.token === f.input.credentials.client_secret,
      ),
    ).toBe(auth !== "none");
    const view = views.at(-1);
    if (!view) throw new Error("Missing connected view");
    expect(nativeDeviceViewSeams.authorization(view.connectionId)?.status).toBe(
      "active",
    );
  },
);
it("preserves genuine WorkOS CIMD selection and its legacy saved bytes", async () => {
  const f = await setup("workos", "none");
  const plan = connectPlan("workos");
  const profile = nativeBrowserOAuthProfile("workos");
  if (!plan || !profile) throw new Error("Missing WorkOS contract");
  const descriptor = nativeProviderDescriptor(plan, {
    callbackUrl: f.state.redirectUri,
    apiKey: { available: false },
    oauth: { available: true, profile },
    mcp: { available: false, actor: "user" },
  });
  const method = descriptor.methods.find((row) => row.id === "oauth");
  if (!method) throw new Error("Missing OAuth descriptor");
  const view = await f.driver.configure({
    ...f.input,
    parameters: nativeFieldValues(
      method.fields,
      nativeInitialValues(method),
      false,
    ),
    credentials: {},
    requestedScopes: { user: [...profile.requiredScopes] },
  });
  expect(view.configuration.clientId).toBe(
    new URL("native-client.json", f.state.redirectUri).href,
  );
  expect(view.configuration.parameters).toEqual({});
  expect(nativeOAuthClientConfigured(view.configuration)).toBe(false);
  expect(f.requests).toEqual([]);
});
it("rejects partial registered targets without falling back to public CIMD", async () => {
  const f = await setup("workos", "none");
  await expect(
    f.driver.configure({
      ...f.input,
      parameters: { client_id: "operator", token_auth_method: "none" },
    }),
  ).rejects.toThrow();
  expect(f.requests).toEqual([]);
  const before = f.captures();
  const configured = f.driver.configure(f.input);
  expect(f.captures()).toBe(before + 1);
  const view = await configured;
  expect(view.status).toBe("configuration");
  expect(nativeOAuthClientConfigured(view.configuration)).toBe(true);
  expect(f.requests).toEqual([]);
});
it("forwards caller abort and never adopts a replacement route during an actual held JSON read", async () => {
  const f = await setup();
  const connected = await f.controller.connect(f.input);
  const caller = new AbortController();
  caller.abort();
  const count = f.requests.length;
  await expect(
    f.driver.invoke(
      connected.connectionId,
      "provider.resource.read",
      {},
      caller.signal,
    ),
  ).rejects.toThrow();
  expect(f.requests).toHaveLength(count);
  f.state.holdResource = true;
  const pending = f.driver.invoke(
    connected.connectionId,
    "provider.resource.read",
    {},
  );
  const rejected = expect(pending).rejects.toThrow();
  operations.push(rejected);
  await f.entered.promise;
  f.replaceRoute();
  await rejected;
  f.release.resolve();
  expect(f.requests).toHaveLength(count + 1);
});
