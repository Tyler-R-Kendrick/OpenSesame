/**
 * What a device session is bound to (ADR 0160): the key, not the tomb's name;
 * what happens when no key can be had; and which claim routes answer while
 * a vault is shut.
 */

/** @vitest-environment jsdom */
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import {
  KEY_PATH,
  harness,
  me,
  mint,
  open,
  plant,
  session,
  stored,
  useDeviceIdentityHarness,
} from "./__tests__/device-identity-harness.js";
import { deviceIdentityFetch } from "./device-identity-host.js";
import {
  ensureDeviceIdentityKey,
  forgetDeviceIdentityKeyInFlightForTests,
} from "./device-identity-key.js";
import {
  type DeviceRouteRequest,
  registerDeviceRoutes,
} from "./device-identity-routes.js";
import { readFile } from "./vfs.js";

useDeviceIdentityHarness();

describe("a key record this build cannot read", () => {
  it("still opens a provisional session: random, unbound, provisional, and says why", async () => {
    const tomb = await open();
    await plant(tomb, '{"version":2,"from":"a newer build"}');
    const res = await mint();
    expect(res.status).toBe(201);
    const body = overlapCast(await res.json());
    expect(body.identityKey).toBe("unreadable");
    expect(String(body.principalId)).toMatch(/^prn_[A-Za-z0-9_-]{16}$/);
    const principal = overlapCast(
      await (await me(String(body.accessToken))).json(),
    );
    expect(principal).toMatchObject({
      id: body.principalId,
      state: "provisional",
      assurance: "provisional",
    });
    expect(principal.verifiedAt).toBeUndefined();
  });

  it("never overwrites or destroys the record", async () => {
    const tomb = await open();
    const unknown = '{"version":2,"from":"a newer build"}';
    await plant(tomb, unknown);
    await mint();
    await mint();
    expect(await stored(tomb)).toBe(unknown);
  });

  it("does not bind that session to the vault, so it is no member's principal", async () => {
    const tomb = await open();
    await plant(tomb, "not json");
    const minted = await session();
    const seen: DeviceRouteRequest[] = [];
    registerDeviceRoutes({
      id: "probe",
      routes: {
        directory: async (received) => {
          seen.push(received);
          return new Response("{}");
        },
      },
    });
    await deviceIdentityFetch("/v1/projects", {
      headers: { authorization: `Bearer ${minted.accessToken}` },
    });
    expect(seen[0]?.caller).toEqual({
      principalId: minted.principalId,
      tomb: "",
      guest: false,
    });
  });
});

describe("with no cross-tab lock", () => {
  it("opens a provisional session and mints no key", async () => {
    const tomb = await open();
    vi.stubGlobal("navigator", {});
    const res = await mint();
    expect(res.status).toBe(201);
    const body = overlapCast(await res.json());
    expect(body.identityKey).toBe("no-fence");
    expect(String(body.principalId)).toMatch(/^prn_[A-Za-z0-9_-]{16}$/);
    await expect(readFile(tomb, KEY_PATH)).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("binds to a key that already exists, with or without the lock", async () => {
    const tomb = await open();
    const key = await ensureDeviceIdentityKey(tomb);
    forgetDeviceIdentityKeyInFlightForTests();
    vi.stubGlobal("navigator", {});
    expect((await session()).principalId).toBe(key.principalId);
  });
});

describe("a tomb whose key changed under a live bearer", () => {
  async function replaceKey(tomb: string): Promise<void> {
    const other = await open();
    await ensureDeviceIdentityKey(other);
    await plant(tomb, await stored(other));
    harness.view = {
      kind: "unlocked",
      tomb,
      guest: harness.view.kind === "unlocked" && harness.view.guest,
    };
  }

  it("ends the bearer when a same-named tomb holds another key", async () => {
    const tomb = await open(true);
    const minted = await session();
    expect((await me(minted.accessToken)).status).toBe(200);
    await replaceKey(tomb);
    const res = await me(minted.accessToken);
    expect(res.status).toBe(401);
    // Gone, not merely refused once: the old principal does not come back.
    expect((await me(minted.accessToken)).status).toBe(401);
  });

  it("refuses a claim, and a capability call is handed no caller", async () => {
    const tomb = await open();
    const minted = await session();
    await replaceKey(tomb);
    const claim = await deviceIdentityFetch("/v1/claims", {
      method: "POST",
      headers: { authorization: `Bearer ${minted.accessToken}` },
      body: JSON.stringify({ targetManifest: { kind: "drop" } }),
    });
    expect(claim.status).toBe(401);
  });

  it("fails closed when the key can no longer be read", async () => {
    const tomb = await open();
    const minted = await session();
    await plant(tomb, "garbage");
    expect((await me(minted.accessToken)).status).toBe(401);
  });

  it("keeps the bearer while the same key is in place", async () => {
    await open();
    const minted = await session();
    expect((await me(minted.accessToken)).status).toBe(200);
    expect((await me(minted.accessToken)).status).toBe(200);
  });
});

describe("claims while a vault is shut", () => {
  const claimBody = JSON.stringify({ targetManifest: { kind: "drop" } });

  it("refuses to seal a claim for a session minted before any vault existed", async () => {
    const early = await session();
    await open();
    harness.view = { kind: "locked" };
    const create = await deviceIdentityFetch("/v1/claims", {
      method: "POST",
      headers: { authorization: `Bearer ${early.accessToken}` },
      body: claimBody,
    });
    expect(create.status).toBe(423);
    expect(overlapCast(await create.json()).error).toBe("locked");
  });

  it("polls and presents a sealed claim while the vault is locked", async () => {
    const early = await session();
    await open();
    const create = await deviceIdentityFetch("/v1/claims", {
      method: "POST",
      headers: { authorization: `Bearer ${early.accessToken}` },
      body: JSON.stringify({
        targetManifest: { kind: "drop", digest: "abc" },
      }),
    });
    expect(create.status).toBe(201);
    const claim = overlapCast(await create.json());
    const pollPath = `/v1/claims/${encodeURIComponent(String(claim.claimId))}/poll`;
    const tokenHeaders = { "x-claim-token": String(claim.claimToken) };

    const openPoll = await deviceIdentityFetch(pollPath, {
      headers: tokenHeaders,
    });
    expect(openPoll.status).toBe(200);
    expect(overlapCast(await openPoll.json()).status).toBe("pending");

    harness.view = { kind: "locked" };

    const lockedPoll = await deviceIdentityFetch(pollPath, {
      headers: tokenHeaders,
    });
    expect(lockedPoll.status).toBe(200);
    expect(overlapCast(await lockedPoll.json()).status).toBe("pending");

    const present = await deviceIdentityFetch("/v1/claims/present", {
      method: "POST",
      body: JSON.stringify({
        token: claim.claimToken,
        userCode: claim.userCode,
      }),
    });
    expect(present.status).toBe(200);
    expect(overlapCast(await present.json()).targetManifest).toEqual({
      kind: "drop",
      digest: "abc",
    });

    const after = await deviceIdentityFetch(pollPath, {
      headers: tokenHeaders,
    });
    expect(after.status).toBe(200);
    expect(overlapCast(await after.json()).status).toBe("consumed");
  });

  it("still creates a claim for that same session once the vault is open", async () => {
    const early = await session();
    const tomb = await open();
    const create = await deviceIdentityFetch("/v1/claims", {
      method: "POST",
      headers: { authorization: `Bearer ${early.accessToken}` },
      body: claimBody,
    });
    expect(create.status).toBe(201);
    expect(tomb).toBeTruthy();
  });

  it("leaves health and revoke working while locked", async () => {
    const early = await session();
    harness.view = { kind: "locked" };
    expect((await deviceIdentityFetch("/v1/health/live")).status).toBe(200);
    const revoked = await deviceIdentityFetch(
      "/v1/principals/provisional/revoke",
      {
        method: "POST",
        headers: { authorization: `Bearer ${early.accessToken}` },
      },
    );
    expect(revoked.status).toBe(200);
  });
});
