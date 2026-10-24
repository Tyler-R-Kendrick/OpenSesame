import { createNativeBrowserOAuthDriver } from "@opensesame/app-core/lib/native-browser-oauth-connectors.js";
import { retainAndVerifyNativeBrowserToken } from "@opensesame/app-core/lib/native-browser-oauth-finish.js";
import { refreshNativeBrowserToken } from "@opensesame/app-core/lib/native-browser-oauth-token.js";
import {
  removeNativeConnectorWithCleanup,
  retryNativeConnectorCleanup,
} from "@opensesame/app-core/lib/native-connector-lifecycle.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { requireNativeOAuthRecord } from "@opensesame/app-core/lib/native-oauth-session.js";
import { oauthDraft } from "@opensesame/app-core/lib/native-oauth.test-support.js";
import { afterEach, expect, it } from "vitest";
import { cleanupOwnedFixture } from "./native-cleanup-owner.test-support.js";
import { composeNativeOAuthResourceDriver } from "./native-oauth-resource-runtime.js";

const fixtures: Awaited<ReturnType<typeof cleanupOwnedFixture>>[] = [];
const operations: Promise<unknown>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0).reverse()) await f.close();
  await Promise.allSettled(operations.splice(0));
});
async function setup(configured = false) {
  const f = await cleanupOwnedFixture((authority) =>
    configured
      ? composeNativeOAuthResourceDriver(
          createNativeBrowserOAuthDriver(authority),
          authority,
          "https://operator.example/auth/native-connector.html",
        )
      : createNativeBrowserOAuthDriver(authority),
  );
  fixtures.push(f);
  return f;
}
async function closesWithinTwoSeconds(
  f: Awaited<ReturnType<typeof setup>>,
  withdraw: () => void,
) {
  await f.state.entered.promise;
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(f.state.closedEarly).toBe(false);
  const start = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Original cleanup TLS did not close under2s")),
      2000,
    );
  });
  withdraw();
  try {
    await Promise.race([f.state.closed.promise, limit]);
  } finally {
    clearTimeout(timer);
  }
  expect(performance.now() - start).toBeLessThan(2000);
  expect(f.state.closedEarly).toBe(true);
}
it("captures explicit cleanup before prepare yields, revokes both actual tokens over the same TLS route and clears its obligation", async () => {
  const f = await setup();
  const { id } = await f.seed();
  f.state.gate = true;
  const before = f.captures;
  const retry = retryNativeConnectorCleanup(id);
  operations.push(retry);
  expect(f.captures).toBe(before + 1);
  await f.state.prepared.promise;
  expect(f.state.records).toEqual([]);
  f.state.release.resolve();
  await retry;
  expect(f.captures).toBe(before + 1);
  expect(f.state.records.map((r) => [r.method, r.path, r.epoch])).toEqual([
    ["POST", "/oauth/revoke", "0"],
    ["POST", "/oauth/revoke", "0"],
  ]);
  expect(
    f.state.records.map((r) => new URLSearchParams(r.body).get("token")),
  ).toEqual(["owned-refresh", "owned-access"]);
  expect(f.state.errors).toEqual([]);
  expect(requireNativeOAuthRecord(id).privateState.recovery).toEqual([]);
});
it.each(["route", "activation"])(
  "rejects %s replacement after entry/prepare await without adopting a later route",
  async (owner) => {
    const f = await setup();
    const { id } = await f.seed();
    f.state.gate = true;
    const before = f.captures;
    const retry = retryNativeConnectorCleanup(id);
    operations.push(retry);
    const rejected = expect(retry).rejects.toThrow();
    expect(f.captures).toBe(before + 1);
    await f.state.prepared.promise;
    if (owner === "route") f.replaceRoute();
    else f.replaceActivation();
    f.state.release.resolve();
    await rejected;
    expect(f.captures).toBe(before + 1);
    expect(f.state.records).toEqual([]);
    expect(requireNativeOAuthRecord(id).privateState.recovery).toHaveLength(1);
  },
);
it("a separate explicit cleanup action can capture a fresh node in the same retained activation", async () => {
  const f = await setup();
  const { id } = await f.seed();
  f.replaceRoute();
  const before = f.captures;
  await retryNativeConnectorCleanup(id);
  expect(f.captures).toBe(before + 1);
  expect(f.state.records.map((r) => r.epoch)).toEqual(["1", "1"]);
  expect(requireNativeOAuthRecord(id).privateState.recovery).toEqual([]);
});
it("removal captures synchronously and never deletes the connector after original route withdrawal", async () => {
  const f = await setup();
  const { id } = await f.seed();
  f.state.gate = true;
  const before = f.captures;
  const removing = removeNativeConnectorWithCleanup(id);
  operations.push(removing);
  const rejected = expect(removing).rejects.toThrow();
  expect(f.captures).toBe(before + 1);
  await f.state.prepared.promise;
  f.replaceRoute();
  f.state.release.resolve();
  await rejected;
  expect(readNativeConnector(id)).not.toBeNull();
  expect(requireNativeOAuthRecord(id).privateState.recovery).toHaveLength(1);
  expect(f.state.records).toEqual([]);
});
it.each(["route", "activation"])(
  "held revocation %s withdrawal physically closes original TLS under2s",
  async (owner) => {
    const f = await setup();
    const { id } = await f.seed();
    f.state.hold = true;
    const before = f.captures;
    const retry = retryNativeConnectorCleanup(id);
    operations.push(retry);
    const rejected = expect(retry).rejects.toThrow();
    await closesWithinTwoSeconds(f, () =>
      owner === "route" ? f.replaceRoute() : f.replaceActivation(),
    );
    await rejected;
    expect(f.captures).toBe(before + 1);
    expect(f.state.records).toHaveLength(1);
    expect(requireNativeOAuthRecord(id).privateState.recovery).toHaveLength(1);
  },
);
it("automatic verification-failure cleanup keeps its supplied authorization route through delayed preparation", async () => {
  const f = await setup();
  const { id, pending } = await f.seed("configure");
  f.state.gate = true;
  const original = f.authority.capture();
  const before = f.captures;
  const operation = retainAndVerifyNativeBrowserToken(
    id,
    "owned-obligation",
    pending,
    {
      accessToken: "owned-access",
      refreshToken: "owned-refresh",
      expiresAt: Date.now() + 900000,
      scopes: ["read_user"],
      protocolValid: true,
    },
    original,
    true,
  );
  operations.push(operation);
  const rejected = expect(operation).rejects.toThrow();
  await f.state.prepared.promise;
  f.replaceRoute();
  f.state.release.resolve();
  await rejected;
  expect(f.captures).toBe(before);
  expect(f.state.records.map((r) => r.path)).toEqual(["/api/v4/user"]);
  expect(requireNativeOAuthRecord(id).privateState.recovery).toHaveLength(1);
});
it("already-issued refresh rotation remains durable after owner withdrawal instead of losing the new credential", async () => {
  const f = await setup();
  const { id } = await f.seed();
  f.state.hold = true;
  f.driver.cleanup.cleanup = async (entry, context) => {
    if (!entry.grant?.refreshToken || !context.transport)
      throw new Error("Missing original cleanup context");
    const issued = await refreshNativeBrowserToken(
      context.configuration,
      entry.grant.refreshToken,
      context.transport,
    );
    await context.persistGrantRotation({
      ...entry.grant,
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken ?? entry.grant.refreshToken,
    });
    throw new Error("Retain rotation for another cleanup action");
  };
  const retry = retryNativeConnectorCleanup(id);
  operations.push(retry);
  const rejected = expect(retry).rejects.toThrow();
  await f.state.entered.promise;
  f.replaceRoute();
  f.state.refreshRelease.resolve();
  await rejected;
  const record = requireNativeOAuthRecord(id);
  expect(record.privateState.recovery[0]?.grant).toMatchObject({
    accessToken: "rotated-access",
    refreshToken: "rotated-refresh",
  });
  expect(record.privateState.grants).toEqual({});
  expect(f.state.records.map((r) => r.path)).toEqual(["/oauth/token"]);
  expect(f.state.errors).toEqual([]);
});
it("configured local cleanup reuses the entry route across both vault custody awaits without second capture", async () => {
  const f = await setup(true);
  const draft = oauthDraft();
  draft.parameters = {
    client_id: "public-browser-client",
    issuer: "https://gitlab.com",
    authorization_endpoint: "https://gitlab.com/oauth/authorize",
    token_endpoint: "https://gitlab.com/oauth/token",
    token_auth_method: "none",
    resource: "https://gitlab.com/api/v4/user",
  };
  const { id } = await f.seed("revoke", draft);
  const before = f.captures;
  await retryNativeConnectorCleanup(id);
  expect(f.captures).toBe(before + 1);
  expect(f.state.records).toEqual([]);
  expect(requireNativeOAuthRecord(id).privateState.recovery).toEqual([]);
});
