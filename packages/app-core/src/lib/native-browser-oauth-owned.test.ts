import { afterEach, describe, expect, it } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import { publicOAuthOwnedFixture } from "./native-browser-oauth-owned.test-support.js";
import { readNativeConnector } from "./native-connector-store.js";
import { requireNativeOAuthRecord } from "./native-oauth-session.js";

const fixtures: Awaited<ReturnType<typeof publicOAuthOwnedFixture>>[] = [];
const operations: Promise<unknown>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.close();
  await Promise.allSettled(operations.splice(0));
});
async function setup(id = "resend") {
  const f = await publicOAuthOwnedFixture(id);
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
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Original resource TLS did not close under2s")),
      2000,
    );
  });
  withdraw();
  try {
    await Promise.race([f.state.closed.promise, limit]);
  } finally {
    clearTimeout(timer);
  }
  expect(performance.now() - started).toBeLessThan(2000);
  expect(f.state.closedEarly).toBe(true);
}

describe("public OAuth one original native route per explicit operation", () => {
  it("permits Resend only through real configured native authority and retains that route through CIMD, popup, PKCE and verification", async () => {
    const f = await setup();
    const configuring = f.driver.configure(f.draft);
    expect(f.captures).toBe(1);
    const saved = await configuring;
    const authorizing = f.driver.authorize?.(saved.connectionId);
    expect(f.captures).toBe(2);
    await authorizing;
    expect(f.captures).toBe(2);
    expect(f.state.errors).toEqual([]);
    expect(f.state.records.map((r) => r.path)).toEqual([
      "/.well-known/oauth-authorization-server",
      "/auth/native-client.json",
      "/.well-known/oauth-authorization-server",
      "/auth/native-client.json",
      "/oauth/token",
      "/domains",
    ]);
    expect(readNativeConnector(saved.connectionId)).toMatchObject({
      status: "connected",
      identity: {
        assurance: "credential-valid",
        label: "Resend domain access verified",
      },
    });
    expect(JSON.stringify(readDeviceRows())).not.toContain(
      "owned-public-oauth-issued-access",
    );
  });
  it("does not capture a later route while consent returns and never issues a token after replacement", async () => {
    const f = await setup();
    const saved = await f.driver.configure(f.draft);
    f.onConsent = () => f.replaceRoute();
    await expect(f.driver.authorize?.(saved.connectionId)).rejects.toThrow();
    expect(f.captures).toBe(2);
    expect(f.state.records.some((r) => r.path === "/oauth/token")).toBe(false);
    expect(readNativeConnector(saved.connectionId)?.status).not.toBe(
      "connected",
    );
  });
  it("captures configure before its first await and refuses replacement without durable configuration", async () => {
    const f = await setup();
    const operation = f.driver.configure(f.draft);
    expect(f.captures).toBe(1);
    f.replaceRoute();
    await expect(operation).rejects.toThrow();
    expect(readDeviceRows()).toHaveLength(0);
    expect(f.state.records).toHaveLength(0);
  });
  it("the retained driver never adopts a replacement activation", async () => {
    const f = await setup();
    f.replaceActivation();
    await expect(f.driver.configure(f.draft)).rejects.toThrow();
    expect(f.captures).toBe(0);
    expect(f.state.records).toHaveLength(0);
    expect(readDeviceRows()).toHaveLength(0);
  });
  it("verifies using exactly one synchronous original capture", async () => {
    const f = await setup();
    const saved = await f.seed();
    const before = f.captures;
    const verifying = f.driver.verify(saved.connectionId);
    expect(f.captures).toBe(before + 1);
    expect((await verifying).status).toBe("connected");
    expect(f.captures).toBe(before + 1);
    expect(f.state.records.map((r) => r.path)).toEqual(["/domains"]);
  });
  it.each(["caller", "route", "activation"])(
    "%s withdrawal physically closes held resource TLS before15s deadline",
    async (owner) => {
      const f = await setup();
      const saved = await f.seed();
      expect(saved.status).toBe("connected");
      f.state.hold = "/domains";
      const caller = new AbortController();
      const before = f.captures;
      const operation = f.driver.invoke(
        saved.connectionId,
        "provider.read",
        {},
        caller.signal,
      );
      operations.push(operation);
      const rejected = expect(operation).rejects.toThrow();
      expect(f.captures).toBe(before + 1);
      await closesWithinTwoSeconds(f, () => {
        if (owner === "caller") caller.abort();
        else if (owner === "route") f.replaceRoute();
        else f.replaceActivation();
      });
      await rejected;
      expect(f.captures).toBe(before + 1);
      expect(f.state.records.map((r) => r.path)).toEqual(["/domains"]);
    },
  );
  it("extra Codeberg repository operation uses the original verification route without recapturing", async () => {
    const f = await setup("codeberg");
    const saved = await f.seed();
    const before = f.captures;
    const result = await f.driver.invoke(
      saved.connectionId,
      "provider.repositories.read",
      {},
    );
    expect(f.captures).toBe(before + 1);
    expect(f.state.records.map((r) => r.path)).toEqual([
      "/api/v1/user",
      "/api/v1/user/repos?limit=100",
    ]);
    expect(result.items).toEqual([
      {
        id: "42",
        label: "owned/project",
        url: "https://codeberg.org/owned/project",
      },
    ]);
    expect(f.state.errors).toEqual([]);
    expect(
      requireNativeOAuthRecord(saved.connectionId).privateState.recovery,
    ).toEqual([]);
  });
  it("Discord identity verification and actual guild list retain one original route", async () => {
    const f = await setup("discord");
    f.draft.requestedScopes.user?.push("guilds");
    f.state.replies.set("/api/v10/oauth2/@me", {
      application: { id: "public-browser-client" },
      scopes: ["identify", "guilds"],
      expires: new Date(Date.now() + 900000).toISOString(),
      user: { id: "7" },
    });
    f.state.replies.set("/api/v10/users/@me", {
      id: "7",
      username: "owned-user",
    });
    f.state.replies.set("/api/v10/users/@me/guilds?limit=200", [
      { id: "123", name: "Owned server" },
    ]);
    const saved = await f.seed();
    const before = f.captures;
    const result = await f.driver.invoke(
      saved.connectionId,
      "provider.guilds.read",
      {},
    );
    expect(f.captures).toBe(before + 1);
    expect(f.state.records.map((r) => r.path)).toEqual([
      "/api/v10/oauth2/@me",
      "/api/v10/users/@me",
      "/api/v10/users/@me/guilds?limit=200",
    ]);
    expect(result.items).toEqual([
      {
        id: "123",
        label: "Owned server",
        url: "https://discord.com/channels/123",
      },
    ]);
    expect(f.state.errors).toEqual([]);
  });
  it("Codeberg caller cancellation closes original TLS under2s without waiting for HTTP deadline", async () => {
    const f = await setup("codeberg");
    const saved = await f.seed();
    expect(saved.status).toBe("connected");
    f.state.hold = "/api/v1/user";
    const caller = new AbortController();
    const operation = f.driver.invoke(
      saved.connectionId,
      "provider.read",
      {},
      caller.signal,
    );
    operations.push(operation);
    const rejected = expect(operation).rejects.toThrow();
    await closesWithinTwoSeconds(f, () => caller.abort());
    await rejected;
  });
});
