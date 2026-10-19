import { type ChannelListener, channel } from "node:diagnostics_channel";
import { IncomingMessage, ServerResponse } from "node:http";
import type { JsonValue } from "@opensesame/os-domain";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { nativeBrowserOAuthPolicy } from "./native-browser-policy.js";
import { readNativeConnector } from "./native-connector-store.js";
import { bindNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";
import { captureOAuthCarrier } from "./native-oauth-carrier.test-support.js";
import { nativeOAuthClientFixture } from "./native-oauth-client.test-support.js";
import { createNativeOAuthResourceDriver } from "./native-oauth-resource-driver.js";
import { requireNativeOAuthRecord } from "./native-oauth-session.js";

const closes: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
async function setup(native = true) {
  const f = await nativeOAuthClientFixture("client_secret_basic");
  closes.push(f.close);
  const carrier = captureOAuthCarrier(
    f.owner,
    new URL(f.state.resource).origin,
  );
  closes.push(carrier.close);
  const original = native ? carrier.owner : f.owner;
  let onConsent = () => {};
  closes.push(
    bindNativeOAuthBrowserPort({
      redirectUri: original.redirectUri,
      navigate: () => {
        throw new Error("Unexpected direct navigation");
      },
      scrubCallback() {},
      captureAuthorizationGuard: () => () =>
        carrier.authorization.signal.throwIfAborted(),
      authorize: async (url) => {
        const target = new URL(url);
        f.state.challenge = target.searchParams.get("code_challenge") ?? "";
        onConsent();
        return new URLSearchParams({
          native_state: target.searchParams.get("state") ?? "",
          native_code: "one-use-code",
        }).toString();
      },
    }),
  );
  let captures = 0;
  let releases = 0;
  const driver = createNativeOAuthResourceDriver({
    supports: (id) => id === "resend",
    capture: (signal) => {
      signal?.throwIfAborted();
      captures++;
      return {
        ...original,
        close: () => {
          releases++;
        },
      };
    },
  });
  const input = { ...f.input, providerId: "resend" };
  const authorize = (id: string) => {
    if (!driver.authorize) throw new Error("Missing authorization driver");
    return driver.authorize(id);
  };
  return {
    ...f,
    carrier,
    input,
    driver,
    authorize,
    onConsent: (action: () => void) => {
      onConsent = action;
    },
    counts: () => ({ captures, releases }),
  };
}
/** Change the owned HTTPS server's actual JSON body, never the client transport. */
function replyWith(f: Awaited<ReturnType<typeof setup>>, payload: JsonValue) {
  const statuses: number[] = [];
  const started = channel("http.server.request.start");
  const listener: ChannelListener = (message) => {
    const actual = z
      .object({
        request: z.instanceof(IncomingMessage),
        response: z.instanceof(ServerResponse),
      })
      .parse(message);
    if (
      actual.request.url !== "/resource" ||
      actual.request.headers.host !== new URL(f.state.resource).host
    )
      return;
    const end = actual.response.end.bind(actual.response);
    actual.response.end = () => end(JSON.stringify(payload));
    actual.response.once("finish", () => {
      statuses.push(actual.response.statusCode);
    });
  };
  started.subscribe(listener);
  closes.push(() => {
    started.unsubscribe(listener);
  });
  return statuses;
}
it("runs a refused direct-browser catalog provider through captured token and JSON resource targets", async () => {
  const f = await setup();
  expect(nativeBrowserOAuthPolicy("resend").available).toBe(false);
  const saved = await f.driver.configure(f.input);
  expect(saved.status).toBe("configuration");
  await f.authorize(saved.connectionId);
  expect(readNativeConnector(saved.connectionId)?.status).toBe("connected");
  const result = await f.driver.invoke(
    saved.connectionId,
    "provider.resource.read",
    {},
  );
  expect(JSON.parse(result.items[0]?.secretValue ?? "null")).toEqual({
    projects: [{ id: "project-42", name: "Actual configured project" }],
  });
  expect(f.requests.map((row) => row.path)).toEqual([
    "/token",
    "/resource",
    "/resource",
  ]);
  expect(f.requests[0]?.authorization).toMatch(/^Basic /);
  expect(f.requests[1]?.authorization).toBe("Bearer issued-access-1");
  expect(f.carrier.capture).toHaveBeenCalledTimes(1);
  expect(f.counts().captures).toBe(f.counts().releases);
  f.carrier.withdrawRoute();
  await expect(
    f.driver.invoke(saved.connectionId, "provider.resource.read", {}),
  ).rejects.toThrow();
  expect(f.requests).toHaveLength(3);
  expect(f.carrier.capture).toHaveBeenCalledTimes(1);
});
it("refuses the same catalog provider without its captured native carrier before credentials leave", async () => {
  const f = await setup(false);
  await expect(f.driver.configure(f.input)).rejects.toThrow();
  expect(f.requests).toEqual([]);
  expect(f.state.issued).toBe(0);
  expect(f.counts().captures).toBe(f.counts().releases);
});
it.each(["token_endpoint", "resource"])(
  "refuses an unapproved %s origin before credentials leave",
  async (field) => {
    const f = await setup();
    await expect(
      f.driver.configure({
        ...f.input,
        parameters: {
          ...f.input.parameters,
          [field]: "https://unapproved.example/endpoint",
        },
      }),
    ).rejects.toThrow();
    expect(f.requests).toEqual([]);
    expect(f.state.issued).toBe(0);
  },
);
it("refuses an original route withdrawn during consent before token exchange", async () => {
  const f = await setup();
  const saved = await f.driver.configure(f.input);
  f.onConsent(f.carrier.withdrawRoute);
  await expect(f.authorize(saved.connectionId)).rejects.toThrow();
  expect(f.requests).toEqual([]);
  const record = requireNativeOAuthRecord(saved.connectionId);
  expect(record.privateState.grants).toEqual({});
  expect(record.privateState.recovery).toHaveLength(1);
  expect(record.privateState.recovery[0]?.grant).toBeUndefined();
  expect(record.privateState.recovery[0]?.credentials?.phase).toBe("exchange");
  expect(record.runtime.verifiedAt).toBeNull();
  expect(f.carrier.capture).toHaveBeenCalledTimes(1);
});
it.each([
  { error: "invalid_token" },
  { error: { code: 401, message: "Account authorization refused" } },
  { errors: [{ code: "ACCESS_DENIED", message: "Permission refused" }] },
  { errors: ["Permission refused"] },
  { error_description: "Provider refused the account" },
  { success: false, error: { message: "Denied" } },
  { ok: false, message: "Denied" },
  { status: "error", message: "Denied" },
  { status: "failed", message: "Denied" },
])(
  "refuses real HTTPS200 error envelope %j and preserves the issued journal",
  async (payload) => {
    const f = await setup();
    const statuses = replyWith(f, payload);
    const saved = await f.driver.configure(f.input);
    await expect(f.authorize(saved.connectionId)).rejects.toMatchObject({
      code: "response",
      status: 200,
    });
    const record = requireNativeOAuthRecord(saved.connectionId);
    expect(record.privateState.grants).toEqual({});
    expect(record.privateState.verification).toBeNull();
    expect(record.runtime.verifiedAt).toBeNull();
    expect(record.privateState.recovery).toHaveLength(1);
    expect(record.privateState.recovery[0]).toMatchObject({
      grant: { accessToken: "issued-access-1" },
      credentials: { phase: "verify", protocol_valid: "true" },
    });
    expect(readNativeConnector(saved.connectionId)?.status).not.toBe(
      "connected",
    );
    expect(f.requests.map((row) => row.path)).toEqual(["/token", "/resource"]);
    expect(f.requests[1]?.authorization).toBe("Bearer issued-access-1");
    expect(statuses).toEqual([200]);
  },
);
it.each([null, {}, ""])(
  "returns legitimate JSON data with nested error fields and empty envelope %j",
  async (error) => {
    const f = await setup();
    const payload = {
      projects: [{ id: "project-42" }],
      data: { error: "A domain-specific field" },
      error,
      errors: [],
      error_description: " ",
      success: true,
    };
    const statuses = replyWith(f, payload);
    const saved = await f.driver.configure(f.input);
    await f.authorize(saved.connectionId);
    const result = await f.driver.invoke(
      saved.connectionId,
      "provider.resource.read",
      {},
    );
    expect(JSON.parse(result.items[0]?.secretValue ?? "null")).toEqual(payload);
    expect(readNativeConnector(saved.connectionId)?.status).toBe("connected");
    expect(statuses).toEqual([200, 200]);
  },
);
it("never returns a failed200 envelope or refreshes verification for an active grant", async () => {
  const f = await setup();
  const saved = await f.driver.configure(f.input);
  await f.authorize(saved.connectionId);
  const original = requireNativeOAuthRecord(saved.connectionId);
  const statuses = replyWith(f, { error: "invalid_token" });
  await expect(
    f.driver.invoke(saved.connectionId, "provider.resource.read", {}),
  ).rejects.toMatchObject({ code: "response", status: 200 });
  const current = requireNativeOAuthRecord(saved.connectionId);
  expect(current.runtime.verifiedAt).toBe(original.runtime.verifiedAt);
  expect(current.privateState.grants).toEqual(original.privateState.grants);
  expect(current.privateState.recovery).toEqual([]);
  expect(statuses).toEqual([200]);
});
