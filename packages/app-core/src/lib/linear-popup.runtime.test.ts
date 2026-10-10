import { afterEach, describe, expect, it, vi } from "vitest";
import { readDeviceSecrets } from "./device-connector-records.js";
import { deviceConnection } from "./device-connectors.js";
import { kvSeams } from "./kv.js";
import {
  beginLinearAuthorization,
  configureLinearConnector,
  readLinearConnector,
} from "./linear-connectors.js";
import {
  installLinearRuntimeTests,
  linearAccount,
  linearAnswers,
  linearDraft,
  linearOptions,
  linearToken,
  navigate,
  pendingLinear,
} from "./linear-runtime.test-support.js";
import { linearGrant } from "./linear-store.js";
import {
  type NativeOAuthBrowserPort,
  bindNativeOAuthBrowserPort,
} from "./native-oauth-browser-port.js";

installLinearRuntimeTests();
let unbind: () => void = () => undefined;
afterEach(() => unbind());
function browserPort(
  authorize: NonNullable<NativeOAuthBrowserPort["authorize"]>,
) {
  const release = vi.fn();
  const prepare = vi.fn(() => release);
  unbind = bindNativeOAuthBrowserPort({
    redirectUri:
      "https://app.example.org/OpenSesame/auth/native-connector.html",
    navigate,
    scrubCallback: vi.fn(),
    prepareAuthorization: prepare,
    authorize,
  });
  return { prepare, release };
}
function response(state: string, error = false) {
  return new URLSearchParams({
    native_state: state,
    ...(error
      ? { native_error: "access_denied" }
      : { native_code: "issued-code" }),
  }).toString();
}
async function configured(userScopes: string[] = []) {
  const saved = await configureLinearConnector(linearDraft("oauth"), {
    ...linearOptions,
    userScopes,
  });
  navigate.mockReset();
  return saved.connectionId;
}

describe("Linear consent returns to the originating unlocked runtime", () => {
  it("reserves at the configuration click before durable writes and reuses that window for consent", async () => {
    const authorize = vi.fn<NonNullable<NativeOAuthBrowserPort["authorize"]>>(
      async (_url, options) => response(options.state),
    );
    const window = browserPort(authorize);
    linearAnswers({ body: linearToken }, { body: { data: linearAccount } });
    const configuration = configureLinearConnector(
      linearDraft("oauth"),
      linearOptions,
    );
    expect(window.prepare).toHaveBeenCalledOnce();
    expect(authorize).not.toHaveBeenCalled();
    const connection = await configuration;
    expect(connection.status).toBe("active");
    expect(authorize).toHaveBeenCalledOnce();
    expect(window.prepare).toHaveBeenCalledOnce();
    expect(window.release).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("releases the reserved window when initial durable configuration fails", async () => {
    const authorize = vi.fn<NonNullable<NativeOAuthBrowserPort["authorize"]>>();
    const window = browserPort(authorize);
    vi.mocked(kvSeams.kvSetDurable).mockRejectedValueOnce(
      new Error("Storage quota"),
    );
    await expect(
      configureLinearConnector(linearDraft("oauth"), linearOptions),
    ).rejects.toThrow("Storage quota");
    expect(window.prepare).toHaveBeenCalledOnce();
    expect(window.release).toHaveBeenCalledOnce();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("verifies an API-key connection without opening an OAuth window", async () => {
    const authorize = vi.fn<NonNullable<NativeOAuthBrowserPort["authorize"]>>();
    const window = browserPort(authorize);
    linearAnswers({ body: { data: linearAccount } });
    const connection = await configureLinearConnector(
      linearDraft("api-key"),
      linearOptions,
    );
    expect(connection.status).toBe("active");
    expect(window.prepare).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("reserves before narrowing scopes and reconsents after revoking the broader grant", async () => {
    const authorize = vi.fn<NonNullable<NativeOAuthBrowserPort["authorize"]>>(
      async (_url, options) => response(options.state),
    );
    const window = browserPort(authorize);
    linearAnswers({ body: linearToken }, { body: { data: linearAccount } });
    const saved = await configureLinearConnector(linearDraft("oauth"), {
      ...linearOptions,
      appScopes: ["read", "write"],
    });
    const provider = linearAnswers(
      { body: null },
      { body: null },
      {
        body: {
          ...linearToken,
          access_token: "narrower-access",
          scope: "read",
        },
      },
      { body: { data: linearAccount } },
    );
    const edit = configureLinearConnector(
      linearDraft("oauth"),
      linearOptions,
      saved.connectionId,
    );
    expect(window.prepare).toHaveBeenCalledTimes(2);
    expect(authorize).toHaveBeenCalledOnce();
    await edit;
    expect(provider).toHaveBeenCalledTimes(4);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(
      new URL(authorize.mock.calls[1]?.[0]).searchParams.get("scope"),
    ).toBe("read");
    expect(linearGrant(saved.connectionId, "app")?.accessToken).toBe(
      "narrower-access",
    );
    expect(linearGrant(saved.connectionId, "app")?.scopes).toEqual(["read"]);
  });

  it("keeps an already verified grant when renaming without opening another consent window", async () => {
    const authorize = vi.fn<NonNullable<NativeOAuthBrowserPort["authorize"]>>(
      async (_url, options) => response(options.state),
    );
    const window = browserPort(authorize);
    linearAnswers({ body: linearToken }, { body: { data: linearAccount } });
    const saved = await configureLinearConnector(
      linearDraft("oauth"),
      linearOptions,
    );
    await configureLinearConnector(
      { ...linearDraft("oauth"), name: "Renamed Linear" },
      linearOptions,
      saved.connectionId,
    );
    expect(window.prepare).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledOnce();
    expect(linearGrant(saved.connectionId, "app")?.accessToken).toBe(
      "private-access",
    );
  });

  it("reserves synchronously, pins Linear's callback, exchanges and verifies without navigating the tab", async () => {
    const id = await configured();
    const authorize = vi.fn<NonNullable<NativeOAuthBrowserPort["authorize"]>>(
      async (url, options) => {
        expect(new URL(url).searchParams.get("state")).toBe(options.state);
        expect(options.redirectUri).toBe(
          "https://app.example.org/OpenSesame/auth/linear.html",
        );
        expect(pendingLinear(id).state).toBe(options.state);
        return response(options.state);
      },
    );
    const window = browserPort(authorize);
    const fetcher = linearAnswers(
      { body: linearToken },
      { body: { data: linearAccount } },
    );
    const consent = beginLinearAuthorization(id, "app");
    expect(window.prepare).toHaveBeenCalledOnce();
    expect(authorize).not.toHaveBeenCalled();
    await consent;
    expect(window.release).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(deviceConnection(id)?.status).toBe("active");
    expect(linearGrant(id, "app")?.accessToken).toBe("private-access");
    expect(readDeviceSecrets()[id]?.linear_pending).toBeUndefined();
    const exchange = new URLSearchParams(
      String(fetcher.mock.calls[0]?.[1]?.body),
    );
    expect(exchange.get("redirect_uri")).toBe(
      "https://app.example.org/OpenSesame/auth/linear.html",
    );
  });

  it("clears only its unconsumed pending request on cancellation and allows retry", async () => {
    const id = await configured();
    const authorize = vi
      .fn<NonNullable<NativeOAuthBrowserPort["authorize"]>>()
      .mockRejectedValueOnce(new Error("Provider authorization was cancelled"))
      .mockImplementationOnce(async (_url, options) => response(options.state));
    const window = browserPort(authorize);
    const fetcher = linearAnswers(
      { body: linearToken },
      { body: { data: linearAccount } },
    );
    await expect(beginLinearAuthorization(id, "app")).rejects.toThrow(
      "cancelled",
    );
    expect(readDeviceSecrets()[id]?.linear_pending).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    await beginLinearAuthorization(id, "app");
    expect(deviceConnection(id)?.status).toBe("active");
    expect(window.prepare).toHaveBeenCalledTimes(2);
    expect(window.release).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate initiation while consent is in flight", async () => {
    const id = await configured();
    let rejectConsent: (error: Error) => void = () => undefined;
    const authorize = vi.fn<NonNullable<NativeOAuthBrowserPort["authorize"]>>(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectConsent = reject;
        }),
    );
    const window = browserPort(authorize);
    const first = beginLinearAuthorization(id, "app");
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    await expect(beginLinearAuthorization(id, "app")).rejects.toThrow(
      "current Linear sign-in",
    );
    const failed = expect(first).rejects.toThrow("cancelled");
    rejectConsent(new Error("cancelled"));
    await failed;
    expect(window.prepare).toHaveBeenCalledOnce();
    expect(window.release).toHaveBeenCalledOnce();
    expect(readDeviceSecrets()[id]?.linear_pending).toBeUndefined();
  });

  it("never claims another connector's pending request when a port returns the wrong state", async () => {
    const id = await configured();
    const other = await configured();
    const otherState = pendingLinear(other).state;
    browserPort(async () => response(otherState));
    const fetcher = linearAnswers();
    await expect(beginLinearAuthorization(id, "app")).rejects.toThrow(
      "another sign-in request",
    );
    expect(pendingLinear(other).state).toBe(otherState);
    expect(readDeviceSecrets()[id]?.linear_pending).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("consumes provider denial without exchanging or retaining an unusable pending request", async () => {
    const id = await configured();
    browserPort(async (_url, options) => response(options.state, true));
    const fetcher = linearAnswers();
    await expect(beginLinearAuthorization(id, "app")).rejects.toThrow(
      "declined",
    );
    expect(readDeviceSecrets()[id]?.linear_pending).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires a fresh click for the second actor rather than opening a blocked async popup", async () => {
    const id = await configured(["read"]);
    const window = browserPort(async (_url, options) =>
      response(options.state),
    );
    linearAnswers(
      { body: linearToken },
      { body: { data: linearAccount } },
      { body: { ...linearToken, access_token: "user-access", scope: "read" } },
      { body: { data: linearAccount } },
    );
    await beginLinearAuthorization(id, "app");
    expect(window.prepare).toHaveBeenCalledOnce();
    expect(readLinearConnector(id)?.app).not.toBeNull();
    expect(readLinearConnector(id)?.user).toBeNull();
    expect(deviceConnection(id)?.status).toBe("pending");
    expect(readDeviceSecrets()[id]?.linear_pending).toBeUndefined();
    await beginLinearAuthorization(id, "user");
    expect(window.prepare).toHaveBeenCalledTimes(2);
    expect(deviceConnection(id)?.status).toBe("active");
    expect(linearGrant(id, "user")?.accessToken).toBe("user-access");
  });
});
