import { afterEach, describe, expect, it } from "vitest";

import {
  assertHostSessionReach,
  hostSessionAllows,
  hostSessionReachSeams,
} from "./host-session-reach.js";

const original = { ...hostSessionReachSeams };

afterEach(() => {
  Object.assign(hostSessionReachSeams, original);
});

describe("hostSessionAllows", () => {
  it("returns null when no Host sessions are bookmarked", async () => {
    hostSessionReachSeams.listHostSessionBookmarks = async () => [];
    await expect(
      hostSessionAllows("personal", { kind: "vault" }, "read"),
    ).resolves.toBeNull();
  });

  it("lets operators through when Host sessions exist", async () => {
    hostSessionReachSeams.listHostSessionBookmarks = async () => [
      {
        sessionId: "session:1",
        displayName: "Room",
        visibility: "private",
        vaultId: "vault:1",
        openedAt: Date.now(),
      },
    ];
    hostSessionReachSeams.resolveCurrentAccessRole = async () => "operator";
    hostSessionReachSeams.canAccess = () => true;
    await expect(
      hostSessionAllows("personal", { kind: "vault" }, "write"),
    ).resolves.toBe(true);
  });

  it("denies a guest with no mirrored share", async () => {
    hostSessionReachSeams.listHostSessionBookmarks = async () => [
      {
        sessionId: "session:1",
        displayName: "Room",
        visibility: "private",
        vaultId: "vault:1",
        openedAt: Date.now(),
      },
    ];
    hostSessionReachSeams.resolveCurrentAccessRole = async () => "guest";
    hostSessionReachSeams.canAccess = () => false;
    hostSessionReachSeams.currentSession = () => ({
      principalId: "principal:11111111-1111-4111-8111-111111111111",
      accessToken: "t",
      issuerOrigin: "https://id.example",
    });
    hostSessionReachSeams.listLocalShares = async () => [];
    await expect(
      hostSessionAllows(
        "personal",
        { kind: "item", id: "22222222-2222-4222-8222-222222222222" },
        "read",
      ),
    ).resolves.toBe(false);
    await expect(
      assertHostSessionReach(
        "personal",
        { kind: "item", id: "22222222-2222-4222-8222-222222222222" },
        "read",
      ),
    ).rejects.toThrow("host_grant_denied");
  });

  it("admits a mirrored item share for the session principal", async () => {
    const principal = "principal:11111111-1111-4111-8111-111111111111";
    const itemId = "22222222-2222-4222-8222-222222222222";
    hostSessionReachSeams.listHostSessionBookmarks = async () => [
      {
        sessionId: "session:1",
        displayName: "Room",
        visibility: "private",
        vaultId: "vault:1",
        openedAt: Date.now(),
      },
    ];
    hostSessionReachSeams.resolveCurrentAccessRole = async () => "guest";
    hostSessionReachSeams.canAccess = () => false;
    hostSessionReachSeams.currentSession = () => ({
      principalId: principal,
      accessToken: "t",
      issuerOrigin: "https://id.example",
    });
    hostSessionReachSeams.listLocalShares = async () => [
      {
        id: "share-1",
        principalId: principal,
        resourceKind: "item",
        resourceId: itemId,
        resourceLabel: "Login",
        policy: "read",
        issuedAt: Date.now() - 1000,
        expiresAt: Date.now() + 60_000,
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    ];
    await expect(
      hostSessionAllows("personal", { kind: "item", id: itemId }, "read"),
    ).resolves.toBe(true);
  });
});
