import { afterEach, expect, it, vi } from "vitest";
import {
  readDeviceRows,
  readDeviceSecrets,
} from "./device-connector-records.js";
import { deviceConnection } from "./device-connectors.js";
import { configureLinearConnector } from "./linear-connectors.js";
import { linearApiSeams } from "./linear-http.js";
import {
  installLinearRuntimeTests,
  linearAccount,
  linearAnswers,
  linearDraft,
  linearOptions,
  linearToken,
  pendingLinear,
} from "./linear-runtime.test-support.js";
import { linearGrant } from "./linear-store.js";
import {
  type NativeOAuthBrowserPort,
  bindNativeOAuthBrowserPort,
} from "./native-oauth-browser-port.js";

installLinearRuntimeTests();
let unbind = () => {};
afterEach(() => unbind());

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Attempt = {
  live: boolean;
  close: ReturnType<typeof vi.fn<() => void>>;
  callback: ReturnType<typeof deferred<string>>;
  state?: string;
};

function browserFixture() {
  const attempts: Attempt[] = [];
  let current: Attempt | undefined;
  const prepare = vi.fn(() => {
    if (current?.live) throw new Error("Previous consent still pending");
    const attempt: Attempt = {
      live: true,
      close: vi.fn(() => {
        attempt.live = false;
        if (current === attempt) current = undefined;
      }),
      callback: deferred<string>(),
    };
    attempts.push(attempt);
    current = attempt;
    return attempt.close;
  });
  const capture = vi.fn(() => {
    const original = current;
    if (!original) throw new Error("Missing original consent reservation");
    return () => {
      if (!original.live) throw new Error("Original consent ended");
    };
  });
  const authorize = vi.fn<NonNullable<NativeOAuthBrowserPort["authorize"]>>(
    async (_url, options) => {
      if (!current) throw new Error("Missing prepared consent");
      current.state = options.state;
      return current.callback.promise;
    },
  );
  unbind = bindNativeOAuthBrowserPort({
    redirectUri:
      "https://app.example.org/OpenSesame/auth/native-connector.html",
    prepareAuthorization: prepare,
    captureAuthorizationGuard: capture,
    authorize,
    navigate: vi.fn(),
    scrubCallback: vi.fn(),
  });
  return { attempts, prepare, capture, authorize };
}

function callback(attempt: Attempt, denied = false) {
  if (!attempt.state) throw new Error("Actual pending consent state missing");
  return new URLSearchParams({
    native_state: attempt.state,
    ...(denied
      ? { native_error: "access_denied" }
      : { native_code: "provider-issued-code" }),
  }).toString();
}

async function start(browser: ReturnType<typeof browserFixture>, name: string) {
  const index = browser.attempts.length;
  const promise = configureLinearConnector(
    { ...linearDraft("oauth"), name },
    linearOptions,
  );
  void promise.catch(() => {});
  await vi.waitFor(() =>
    expect(browser.authorize).toHaveBeenCalledTimes(index + 1),
  );
  const attempt = browser.attempts[index];
  const row = readDeviceRows().find((entry) => entry.displayName === name);
  if (!attempt || !row) throw new Error("Actual saved consent required");
  expect(pendingLinear(row.connectionId).state).toBe(attempt.state);
  return { attempt, id: row.connectionId, promise };
}

async function finishDenied(entry: Awaited<ReturnType<typeof start>>) {
  entry.attempt.callback.resolve(callback(entry.attempt, true));
  await expect(entry.promise).rejects.toThrow("declined");
}

it("rejects late A before exchange when a real B owns the newer browser guard", async () => {
  const browser = browserFixture();
  const fetcher = linearAnswers(
    { body: linearToken },
    { body: { data: linearAccount } },
  );
  const a = await start(browser, "Original A");
  a.attempt.live = false;
  const b = await start(browser, "New B");
  const pendingB = pendingLinear(b.id);
  try {
    a.attempt.callback.resolve(callback(a.attempt));
    await expect(a.promise).rejects.toThrow(/consent ended|cancelled/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(linearGrant(a.id, "app")).toBeNull();
    expect(deviceConnection(a.id)?.status).toBe("pending");
    expect(readDeviceSecrets()[a.id]?.linear_pending).toBeUndefined();
    expect(pendingLinear(b.id)).toEqual(pendingB);
    expect(b.attempt.close).not.toHaveBeenCalled();
    expect(b.attempt.live).toBe(true);
    expect(a.attempt.close).toHaveBeenCalledOnce();
  } finally {
    await finishDenied(b);
  }
});

it("cleans up an issued A grant after cancellation during token exchange without touching B", async () => {
  const browser = browserFixture();
  const token = deferred<Response>();
  const fetcher = vi.fn<typeof linearApiSeams.fetch>(async (url) => {
    if (String(url).endsWith("/oauth/token")) return token.promise;
    expect(String(url)).toBe("https://api.linear.app/oauth/revoke");
    return Response.json(null);
  });
  linearApiSeams.fetch = fetcher;
  const a = await start(browser, "Held exchange A");
  a.attempt.callback.resolve(callback(a.attempt));
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  a.attempt.live = false;
  const b = await start(browser, "Independent B");
  const pendingB = pendingLinear(b.id);
  try {
    token.resolve(Response.json(linearToken));
    await expect(a.promise).rejects.toThrow(/consent ended|cancelled/);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      fetcher.mock.calls
        .slice(1)
        .map(([, init]) =>
          new URLSearchParams(String(init?.body)).get("token"),
        ),
    ).toEqual([linearToken.refresh_token, linearToken.access_token]);
    expect(linearGrant(a.id, "app")).toBeNull();
    expect(deviceConnection(a.id)?.status).toBe("pending");
    expect(pendingLinear(b.id)).toEqual(pendingB);
    expect(b.attempt.close).not.toHaveBeenCalled();
    expect(b.attempt.live).toBe(true);
  } finally {
    await finishDenied(b);
  }
});

it("releases the original reservation once if the originating observer refuses it before any write", async () => {
  const browser = browserFixture();
  const fetcher = linearAnswers();
  await expect(
    configureLinearConnector(
      linearDraft("oauth"),
      linearOptions,
      undefined,
      undefined,
      () => {
        throw new Error("Originating view ended");
      },
    ),
  ).rejects.toThrow("Originating view ended");
  expect(browser.prepare).toHaveBeenCalledOnce();
  expect(browser.attempts[0]?.close).toHaveBeenCalledOnce();
  expect(browser.authorize).not.toHaveBeenCalled();
  expect(readDeviceRows()).toEqual([]);
  expect(readDeviceSecrets()).toEqual({});
  expect(fetcher).not.toHaveBeenCalled();
});
