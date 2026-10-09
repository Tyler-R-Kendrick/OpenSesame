import { deliverNativeImplicitPayload } from "@opensesame/app-core/browser/native-implicit-session.js";
import { validationBackend } from "@opensesame/app-core/lib/native-twitch-session-validation.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { nativeAuthPopupRuntime } from "./native-auth-popup-runtime.js";

const releases: (() => void)[] = [];
const state = "a".repeat(64);
beforeEach(validationBackend);
afterEach(() => {
  for (const release of releases.splice(0).reverse()) release();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function browser() {
  const popup = {
    opener: null,
    close: vi.fn(),
    location: { replace: vi.fn() },
  };
  const open = vi.fn(() => popup);
  vi.stubGlobal("window", {
    location: new URL("https://selfhost.example"),
    open,
  });
  const context = createTestContext();
  const activation = createActivation(context.ctx, "connectors.external");
  releases.push(activation.dispose);
  const port = nativeAuthPopupRuntime(
    activation,
    "https://selfhost.example/auth/native-connector.html",
    () => context.ctx.lease.signal.throwIfAborted(),
  );
  return { popup, open, context, port };
}
function device() {
  return {
    verificationUri:
      "https://www.twitch.tv/activate?public=true&device-code=CODE",
    userCode: "CODE",
    state,
    expiresAt: Date.now() + 60_000,
  };
}

it("does not reopen an asynchronously cancelled reservation without a fresh click", async () => {
  const flow = browser();
  flow.port.prepareAuthorization?.();
  expect(flow.open).toHaveBeenCalledOnce();
  flow.port.cancelAuthorization?.();
  await expect(
    flow.port.authorize?.("https://provider.example/authorize", {
      state,
      expiresAt: Date.now() + 60_000,
    }),
  ).rejects.toThrow("fresh provider sign-in");
  expect(flow.open).toHaveBeenCalledOnce();
  flow.port.prepareAuthorization?.();
  const consent = flow.port.deviceConsent?.(device());
  expect(consent?.signal.aborted).toBe(false);
  expect(flow.open).toHaveBeenCalledTimes(2);
});

it("cancels on the real vault lock and cannot revive that device attempt", () => {
  const flow = browser();
  const oldRelease = flow.port.prepareAuthorization?.();
  const consent = flow.port.deviceConsent?.(device());
  vaultStore.lock({ recordLastVault: false });
  expect(consent?.signal.aborted).toBe(true);
  flow.port.prepareAuthorization?.();
  const next = flow.port.deviceConsent?.(device());
  oldRelease?.();
  expect(next?.signal.aborted).toBe(false);
  flow.context.abort("capability disabled");
  expect(next?.signal.aborted).toBe(true);
});

it("keeps the attempt cancellable after the real callback returns until the operation releases it", async () => {
  const flow = browser();
  const release = flow.port.prepareAuthorization?.();
  const guard = flow.port.captureAuthorizationGuard?.();
  const result = flow.port.authorize?.("https://provider.example/authorize", {
    state,
    expiresAt: Date.now() + 60_000,
  });
  await vi.waitFor(() =>
    expect(flow.popup.location.replace).toHaveBeenCalledOnce(),
  );
  const callback = new BroadcastChannel(await nativeAuthChannel(state));
  try {
    callback.postMessage({
      kind: "authorization-code",
      redirectUri: "https://selfhost.example/auth/native-connector.html",
      receipt: "b".repeat(64),
      state,
      code: "test-issued-callback-code",
    });
    await expect(result).resolves.toContain(
      "native_code=test-issued-callback-code",
    );
    expect(() => guard?.()).not.toThrow();
    expect(() => flow.port.prepareAuthorization?.()).toThrow(
      "current provider sign-in",
    );
    flow.port.cancelAuthorization?.();
    expect(() => guard?.()).toThrow();
    release?.();
    flow.port.prepareAuthorization?.();
    const next = flow.port.captureAuthorizationGuard?.();
    expect(() => next?.()).not.toThrow();
    expect(() => guard?.()).toThrow();
  } finally {
    callback.close();
  }
});

it("retains and acknowledges a minted bearer after lock while refusing the old runtime result", async () => {
  const flow = browser();
  flow.port.prepareAuthorization?.();
  const authorization =
    await flow.port.prepareImplicitAuthorization?.("discord");
  if (!authorization) throw new Error("Missing implicit authorization");
  let finish: () => void = () => undefined;
  const durable = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const retain = vi.fn(async () => durable);
  const rejected = expect(
    authorization.authorize("https://discord.com/oauth2/authorize", {
      expiresAt: Date.now() + 60_000,
      retain,
    }),
  ).rejects.toMatchObject({ code: "denied" });
  const delivery = deliverNativeImplicitPayload(
    authorization.state,
    "discord",
    authorization.redirectUri,
    {
      accessToken: "test-minted-lock-race-token",
      tokenType: "Bearer",
      expiresIn: 3600,
      scopes: ["identify"],
    },
  );
  await vi.waitFor(() => expect(retain).toHaveBeenCalledOnce());
  vaultStore.lock({ recordLastVault: false });
  finish();
  await rejected;
  await delivery;
  expect(retain).toHaveBeenCalledOnce();
  expect(flow.open).toHaveBeenCalledOnce();
});
import { nativeAuthChannel } from "@opensesame/app-core/browser/native-auth-message.js";
