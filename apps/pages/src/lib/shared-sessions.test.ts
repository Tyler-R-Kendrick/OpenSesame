import { afterEach, describe, expect, it, vi } from "vitest";

import { AccessError } from "./access.js";
import { hostItemId, hostPrincipalId, hostVaultIdForTomb } from "./host-ids.js";
import {
  decideJoinRequest,
  getSharedSession,
  grantSharedSession,
  listJoinRequests,
  openSharedSession,
  revokeSharedSessionGrant,
  sharedSessionSeams,
} from "./shared-sessions.js";

const original = { ...sharedSessionSeams };

afterEach(() => {
  Object.assign(sharedSessionSeams, original);
});

describe("host-ids", () => {
  it("normalizes principal and item ids", () => {
    expect(
      hostPrincipalId("principal:11111111-1111-4111-8111-111111111111"),
    ).toBe("principal:11111111-1111-4111-8111-111111111111");
    expect(hostItemId("22222222-2222-4222-8222-222222222222")).toBe(
      "item:22222222-2222-4222-8222-222222222222",
    );
    expect(hostPrincipalId("not-an-id")).toBeNull();
  });

  it("maps a project tomb to a stable vault id", async () => {
    const a = await hostVaultIdForTomb(
      "prj_33333333-3333-4333-8333-333333333333",
    );
    const b = await hostVaultIdForTomb(
      "prj_33333333-3333-4333-8333-333333333333",
    );
    expect(a).toBe("vault:33333333-3333-4333-8333-333333333333");
    expect(a).toBe(b);
    const personal = await hostVaultIdForTomb("personal");
    expect(personal.startsWith("vault:")).toBe(true);
    expect(personal).toBe(await hostVaultIdForTomb("personal"));
  });
});

describe("shared-sessions client", () => {
  it("opens a session through the Host seam", async () => {
    sharedSessionSeams.openSharedSession = vi.fn(async () => ({
      id: "session:1",
      displayName: "Incident",
      visibility: "public" as const,
      operatorPrincipalId: "principal:1",
      createdAt: "2026-09-15T00:00:00Z",
    }));
    await expect(
      openSharedSession("Incident", "public"),
    ).resolves.toMatchObject({ id: "session:1", visibility: "public" });
  });

  it("admits a join request with a grant and no subject override", async () => {
    const decide = vi.fn(async () => ({
      id: "joinreq:1",
      decision: "admitted",
      grant: {
        grantId: "sgrant:1",
        principalId: "principal:2",
        role: "read" as const,
        expiresAt: "2026-09-15T02:00:00Z",
        grantedBy: "principal:1",
        scope: {
          kind: "collection" as const,
          vaultId: "vault:1",
        },
      },
    }));
    sharedSessionSeams.decideJoinRequest = decide;
    await decideJoinRequest("session:1", "joinreq:1", "admitted", {
      scope: { kind: "collection", vaultId: "vault:1" },
      role: "read",
      expiresAt: "2026-09-15T02:00:00Z",
    });
    expect(decide).toHaveBeenCalledWith(
      "session:1",
      "joinreq:1",
      "admitted",
      expect.objectContaining({
        scope: { kind: "collection", vaultId: "vault:1" },
      }),
    );
  });

  it("maps Host detail, grants, and join requests", async () => {
    sharedSessionSeams.getSharedSession = vi.fn(async () => ({
      id: "session:1",
      displayName: "Room",
      visibility: "private" as const,
      operatorPrincipalId: "principal:1",
      createdAt: "2026-09-15T00:00:00Z",
      closedAt: null,
      participants: [
        {
          principalId: "principal:2",
          role: "read" as const,
          expiresAt: "2026-09-15T02:00:00Z",
          grantId: "sgrant:1",
          grantedBy: "principal:1",
          scope: { kind: "collection" as const, vaultId: "vault:1" },
        },
      ],
    }));
    sharedSessionSeams.listJoinRequests = vi.fn(async () => [
      {
        id: "joinreq:1",
        requesterPrincipalId: "principal:3",
        note: "covering",
        requestedAt: "2026-09-15T00:01:00Z",
      },
    ]);
    sharedSessionSeams.grantSharedSession = vi.fn(async () => ({
      grantId: "sgrant:2",
      principalId: "principal:4",
      role: "write" as const,
      expiresAt: "2026-09-15T03:00:00Z",
      grantedBy: "principal:1",
      scope: {
        kind: "rows" as const,
        vaultId: "vault:1",
        items: ["item:5"],
      },
    }));
    sharedSessionSeams.revokeSharedSessionGrant = vi.fn(async () => undefined);

    await expect(getSharedSession("session:1")).resolves.toMatchObject({
      participants: [{ grantId: "sgrant:1" }],
    });
    await expect(listJoinRequests("session:1")).resolves.toEqual([
      expect.objectContaining({ note: "covering" }),
    ]);
    await expect(
      grantSharedSession("session:1", {
        subjectPrincipalId: "principal:4",
        scope: {
          kind: "rows",
          vaultId: "vault:1",
          items: ["item:5"],
        },
        role: "write",
        expiresAt: "2026-09-15T03:00:00Z",
      }),
    ).resolves.toMatchObject({ grantId: "sgrant:2" });
    await expect(
      revokeSharedSessionGrant("session:1", "sgrant:2"),
    ).resolves.toBeUndefined();
  });

  it("surfaces AccessError from the open seam", async () => {
    sharedSessionSeams.openSharedSession = async () => {
      throw new AccessError(422, "session_display_name", "Name the session.");
    };
    await expect(openSharedSession("   ")).rejects.toBeInstanceOf(AccessError);
  });
});
