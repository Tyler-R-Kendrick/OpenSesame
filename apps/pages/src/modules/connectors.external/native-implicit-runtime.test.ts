import type { NativeAuthPopup } from "@opensesame/app-core/browser/native-auth-session.js";
import { deliverNativeImplicitPayload } from "@opensesame/app-core/browser/native-implicit-session.js";
import type { IssuedNativeOAuthToken } from "@opensesame/app-core/lib/native-browser-oauth-token.js";
import { afterEach, expect, it, vi } from "vitest";
import { nativeImplicitAuthorization } from "./native-implicit-runtime.js";

const payload = {
  accessToken: "test-observed-issued-discord-token",
  tokenType: "Bearer",
  expiresIn: 3600,
  scopes: ["identify"],
};
afterEach(() => vi.unstubAllGlobals());

async function consent() {
  vi.stubGlobal("window", { location: new URL("https://selfhost.example") });
  const cancelled = new AbortController();
  const lifetime = new AbortController();
  const release = vi.fn();
  const close = vi.fn();
  const unavailable = async (): Promise<never> => {
    throw new Error("This test uses the encrypted bearer route");
  };
  const popup: NativeAuthPopup = {
    wait: unavailable,
    waitWebMessage: unavailable,
    showDeviceConsent: () => ({ signal: cancelled.signal, close }),
    showRedirectConsent: () => ({ signal: cancelled.signal, close }),
    cancel: () => cancelled.abort(),
  };
  const authorization = await nativeImplicitAuthorization(
    "discord",
    popup,
    lifetime.signal,
    () => lifetime.signal.throwIfAborted(),
    release,
  );
  let finish: () => void = () => undefined;
  const durable = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const retained: IssuedNativeOAuthToken[] = [];
  const retain = vi.fn(async (token: IssuedNativeOAuthToken) => {
    await durable;
    retained.push(token);
  });
  const activating = vi.fn();
  const result = authorization
    .authorize("https://discord.com/oauth2/authorize", {
      expiresAt: Date.now() + 60_000,
      retain,
    })
    .then((token) => {
      activating(token);
      return token;
    });
  const delivery = deliverNativeImplicitPayload(
    authorization.state,
    "discord",
    authorization.redirectUri,
    payload,
  );
  return {
    result,
    delivery,
    retain,
    retained,
    finish,
    cancelled,
    lifetime,
    activating,
    release,
    close,
  };
}

it("journals and acknowledges a known minted token but refuses activation after explicit Cancel", async () => {
  const flow = await consent();
  const rejected = expect(flow.result).rejects.toMatchObject({
    code: "denied",
  });
  await vi.waitFor(() => expect(flow.retain).toHaveBeenCalledOnce());
  flow.cancelled.abort();
  expect(flow.retained).toEqual([]);
  flow.finish();
  await rejected;
  await flow.delivery;
  expect(flow.retained).toMatchObject([{ accessToken: payload.accessToken }]);
  expect(flow.activating).not.toHaveBeenCalled();
  expect(flow.close).toHaveBeenCalledOnce();
  expect(flow.release).toHaveBeenCalledOnce();
});

it("retains the minted token for recovery but refuses a disposed originating lease", async () => {
  const flow = await consent();
  const rejected = expect(flow.result).rejects.toMatchObject({
    code: "denied",
  });
  await vi.waitFor(() => expect(flow.retain).toHaveBeenCalledOnce());
  flow.lifetime.abort();
  flow.finish();
  await rejected;
  await flow.delivery;
  expect(flow.retained).toMatchObject([{ accessToken: payload.accessToken }]);
  expect(flow.activating).not.toHaveBeenCalled();
  expect(flow.release).toHaveBeenCalledOnce();
});

it("returns the same issued token only after durable retention and encrypted acknowledgement", async () => {
  const flow = await consent();
  await vi.waitFor(() => expect(flow.retain).toHaveBeenCalledOnce());
  expect(flow.activating).not.toHaveBeenCalled();
  flow.finish();
  await expect(flow.result).resolves.toMatchObject({
    accessToken: payload.accessToken,
    protocolValid: true,
  });
  await flow.delivery;
  expect(flow.retained).toHaveLength(1);
  expect(flow.activating).toHaveBeenCalledWith(flow.retained[0]);
  expect(flow.release).toHaveBeenCalledOnce();
});
