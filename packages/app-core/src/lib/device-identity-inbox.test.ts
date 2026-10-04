/**
 * The device plane's `audit` and `requests` families (ADR 0162): what each
 * answers for its own session, what it refuses, and that a shut vault never
 * reaches either.
 */

import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  harness,
  useDeviceIdentityHarness,
} from "./__tests__/device-identity-harness.js";
import { deviceIdentityFetch } from "./device-identity-host.js";
import { LOCAL_IAM_DEVICE_ROUTES } from "./device-identity-local.js";
import { registerDeviceRoutes } from "./device-identity-routes.js";
import { recordReceipt, resetHeldReceiptsForTest } from "./device-receipts.js";
import {
  createLocalAccessRequest,
  decideLocalAccessRequest,
} from "./local-access-requests.js";
import { localRequestFixture } from "./local-request.fixture.js";
import { tombFileKey, vfsSeams } from "./vfs.js";

useDeviceIdentityHarness();

afterEach(() => {
  resetHeldReceiptsForTest();
  vi.restoreAllMocks();
});

async function opened() {
  const fixture = await localRequestFixture();
  harness.view = { kind: "unlocked", tomb: fixture.tomb, guest: false };
  registerDeviceRoutes(LOCAL_IAM_DEVICE_ROUTES);
  const minted = overlapCast(
    await (
      await deviceIdentityFetch("/v1/principals/provisional", {
        method: "POST",
        body: "{}",
      })
    ).json(),
  );
  const token = String(minted.accessToken);
  const ask = (path: string, init: RequestInit = {}) =>
    deviceIdentityFetch(path, {
      ...init,
      headers: { authorization: `Bearer ${token}` },
    });
  const raise = () =>
    createLocalAccessRequest(fixture.tomb, fixture.session, {
      applicationId: fixture.applicationId,
      redirectUri: "https://rp.example.test/callback",
      scopes: ["openid"],
      reason: "Sign in to the test application",
    });
  return { ...fixture, ask, raise };
}

describe("the inbox, as the plane answers it", () => {
  it("answers no one without a live bearer", async () => {
    await opened();
    expect(
      (await deviceIdentityFetch("/v1/authorization-requests")).status,
    ).toBe(401);
    expect((await deviceIdentityFetch("/v1/audit/events")).status).toBe(401);
  });

  it("is empty with nothing waiting", async () => {
    const { ask } = await opened();
    const res = await ask("/v1/authorization-requests?status=pending");
    expect(res.status).toBe(200);
    expect(overlapCast(await res.json()).requests).toEqual([]);
  });

  it("lists a waiting request as the closed contract and nothing more", async () => {
    const { ask, raise } = await opened();
    const pending = await raise();
    const body = overlapCast(
      await (await ask("/v1/authorization-requests")).json(),
    );
    expect(body.requests).toEqual([
      {
        kind: "local-access",
        action: "review",
        ref: pending.id,
        expiresAt: new Date(pending.expiresAt).toISOString(),
      },
    ]);
    // The application, the scopes, the reason and the callback are the
    // request's content; a notification built from a row could carry them.
    const text = JSON.stringify(body);
    for (const content of [
      pending.applicationId,
      pending.reason,
      pending.redirectUri,
      "openid",
    ])
      expect(text).not.toContain(content);
  });

  it("stops listing a request once it is decided", async () => {
    const { ask, raise, tomb, personId } = await opened();
    const pending = await raise();
    await decideLocalAccessRequest(tomb, {
      ...pending,
      principalId: personId,
      decision: "deny",
    });
    expect(
      overlapCast(await (await ask("/v1/authorization-requests")).json())
        .requests,
    ).toEqual([]);
  });

  it("stops listing a request when it lapses", async () => {
    const { ask, raise } = await opened();
    const pending = await raise();
    vi.spyOn(Date, "now").mockReturnValue(pending.expiresAt + 1);
    expect(
      overlapCast(await (await ask("/v1/authorization-requests")).json())
        .requests,
    ).toEqual([]);
  });

  it("does not decide anything: a decision is a ceremony, not a route", async () => {
    const { ask, raise } = await opened();
    const pending = await raise();
    const decide = await ask("/v1/authorization-requests", {
      method: "POST",
      body: JSON.stringify({ ref: pending.id, decision: "approve" }),
    });
    expect(decide.status).toBe(405);
    // A hosted request is addressed by id; this device holds none.
    expect((await ask(`/v1/authorization-requests/${pending.id}`)).status).toBe(
      404,
    );
    expect(
      overlapCast(await (await ask("/v1/authorization-requests")).json())
        .requests,
    ).toHaveLength(1);
  });
});

describe("the receipts, as the plane answers them", () => {
  it("lists the decisions this device made, newest first, and honors a limit", async () => {
    const { ask, raise, tomb, personId } = await opened();
    const pending = await raise();
    await decideLocalAccessRequest(tomb, {
      ...pending,
      principalId: personId,
      decision: "approve",
    });
    const all = overlapCast(await (await ask("/v1/audit/events")).json());
    expect(
      Array.isArray(all.events)
        ? all.events.map((row) => overlapCast(row).eventType)
        : null,
    ).toEqual(["access.request.approved", "access.request.created"]);
    const one = overlapCast(
      await (await ask("/v1/audit/events?limit=1")).json(),
    );
    expect(one.events).toHaveLength(1);
  });

  it("refuses to write, and answers nothing else under its path", async () => {
    const { ask } = await opened();
    expect((await ask("/v1/audit/events", { method: "POST" })).status).toBe(
      405,
    );
    expect((await ask("/v1/audit/events/anything")).status).toBe(404);
  });
});

describe("a session bound to no vault", () => {
  it("reads nothing of whichever vault is open afterwards", async () => {
    // Minted before any vault existed: it has a principal and no tomb.
    const early = overlapCast(
      await (
        await deviceIdentityFetch("/v1/principals/provisional", {
          method: "POST",
          body: "{}",
        })
      ).json(),
    );
    const fixture = await localRequestFixture();
    harness.view = { kind: "unlocked", tomb: fixture.tomb, guest: false };
    registerDeviceRoutes(LOCAL_IAM_DEVICE_ROUTES);
    await createLocalAccessRequest(fixture.tomb, fixture.session, {
      applicationId: fixture.applicationId,
      redirectUri: "https://rp.example.test/callback",
      scopes: ["openid"],
      reason: "Sign in to the test application",
    });
    for (const path of ["/v1/audit/events", "/v1/authorization-requests"]) {
      const res = await deviceIdentityFetch(path, {
        headers: { authorization: `Bearer ${String(early.accessToken)}` },
      });
      expect(res.status, path).toBe(403);
      expect(overlapCast(await res.json()).error).toBe("forbidden");
    }
  });
});

describe("the receipts that are behind", () => {
  it("says how many decisions are made and not yet written", async () => {
    const { ask, tomb } = await opened();
    expect(
      overlapCast(await (await ask("/v1/audit/events")).json()).pending,
    ).toBe(0);
    // The trail's own file refuses a write, as a full disk would.
    const real = vfsSeams.writeRaw;
    vi.spyOn(vfsSeams, "writeRaw").mockImplementation((key, value) =>
      key === tombFileKey(tomb, "config/device-receipts")
        ? Promise.reject(new Error("disk full"))
        : real(key, value),
    );
    await recordReceipt(tomb, "request.denied", { applicationId: "app-1" });
    const behind = await ask("/v1/audit/events");
    expect(overlapCast(await behind.json()).pending).toBe(1);
  });
});

describe("a shut vault", () => {
  it("answers locked for both and reads nothing", async () => {
    const { ask } = await opened();
    harness.view = { kind: "locked" };
    for (const path of ["/v1/audit/events", "/v1/authorization-requests"]) {
      const res = await ask(path);
      expect(res.status).toBe(423);
      expect(overlapCast(await res.json()).error).toBe("locked");
    }
  });
});
