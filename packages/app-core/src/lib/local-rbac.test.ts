/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  changeLocalDirectory,
  ensureOwnerPerson,
  readLocalDirectory,
} from "./local-directory.js";
import { isGuestPersonEntry, mintGuestSessionPerson } from "./local-guest.js";
import {
  accessRoleLabel,
  canAccess,
  hasClaimedOperator,
  resolveAccessRole,
  resolveCurrentAccessRole,
} from "./local-rbac.js";
import { mintVaultKey } from "./vault/crypto.js";
import { vaultStore } from "./vault/store.js";
import { GUEST_TOMB, lockAllTombs, unlockTomb } from "./vfs.js";

let tomb: string;

beforeEach(async () => {
  tomb = `rbac-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  let queue = Promise.resolve();
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0",
    locks: {
      request: <T>(_name: string, run: () => Promise<T>) => {
        const result = queue.then(run);
        queue = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    },
  });
  const session = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => {
      session.set(key, value);
    },
    removeItem: (key: string) => {
      session.delete(key);
    },
    clear: () => {
      session.clear();
    },
  });
  vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
    status: "unlocked",
    guest: false,
    header: null,
    items: [],
    folders: [],
    prefs: {
      autoLockMinutes: 0,
      lockOnHide: false,
      signOutOnLock: false,
      clipboardClearSeconds: 30,
      theme: "system",
    },
    lockedOutUntil: null,
    failedAttempts: 0,
    awaitingSecondStep: false,
    durable: true,
    tomb,
  });
});

afterEach(() => {
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("local RBAC", () => {
  it("maps owner/admin to Operator and Guest N to Guest", async () => {
    const directory = await ensureOwnerPerson(tomb, "Ada");
    const guest = mintGuestSessionPerson();
    const withGuest = await changeLocalDirectory(tomb, directory.revision, {
      action: "create",
      kind: "person",
      name: guest.name,
      id: guest.id,
    });
    const owner = withGuest.entries.find(
      (row) => row.kind === "person" && !isGuestPersonEntry(row),
    );
    expect(owner).toBeTruthy();
    expect(resolveAccessRole(withGuest, owner?.id ?? "")).toBe("operator");
    expect(resolveAccessRole(withGuest, guest.id)).toBe("guest");
    expect(hasClaimedOperator(withGuest)).toBe(true);
    expect(accessRoleLabel("operator")).toBe("Operator");
    expect(canAccess("operator", "manage_grants")).toBe(true);
    expect(canAccess("guest", "manage_grants")).toBe(false);
  });

  it("refuses elevating guest to admin or owner beside a claimed operator", async () => {
    const directory = await ensureOwnerPerson(tomb, "Ada");
    const guest = mintGuestSessionPerson();
    const withGuest = await changeLocalDirectory(tomb, directory.revision, {
      action: "create",
      kind: "person",
      name: guest.name,
      id: guest.id,
    });
    const org = withGuest.entries.find((row) => row.kind === "organization");
    await expect(
      changeLocalDirectory(tomb, withGuest.revision, {
        action: "membership",
        organizationId: org?.id ?? "",
        principalId: guest.id,
        role: "admin",
      }),
    ).rejects.toThrow(/cannot be operators/i);
  });

  it("lets a sole guest act as operator until a claimed operator exists", async () => {
    const guest = mintGuestSessionPerson();
    unlockTomb(GUEST_TOMB, (await mintVaultKey()).vaultKey);
    vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
      status: "unlocked",
      guest: true,
      header: null,
      items: [],
      folders: [],
      prefs: {
        autoLockMinutes: 0,
        lockOnHide: false,
        signOutOnLock: false,
        clipboardClearSeconds: 30,
        theme: "system",
      },
      lockedOutUntil: null,
      failedAttempts: 0,
      awaitingSecondStep: false,
      durable: true,
      tomb: GUEST_TOMB,
    });
    await ensureOwnerPerson(GUEST_TOMB, guest.name);
    expect(await resolveCurrentAccessRole(GUEST_TOMB)).toBe("operator");

    const directory = await readLocalDirectory(GUEST_TOMB);
    const org = directory.entries.find((row) => row.kind === "organization");
    await changeLocalDirectory(GUEST_TOMB, directory.revision, {
      action: "create",
      kind: "person",
      name: "Ada",
    });
    const withAda = await readLocalDirectory(GUEST_TOMB);
    const ada = withAda.entries.find(
      (row) => row.kind === "person" && row.name === "Ada",
    );
    await changeLocalDirectory(GUEST_TOMB, withAda.revision, {
      action: "membership",
      organizationId: org?.id ?? "",
      principalId: ada?.id ?? "",
      role: "owner",
    });
    const next = await readLocalDirectory(GUEST_TOMB);
    expect(hasClaimedOperator(next)).toBe(true);
    expect(
      next.memberships.find((row) => row.principalId === guest.id)?.role,
    ).toBe("member");
    expect(await resolveCurrentAccessRole(GUEST_TOMB)).toBe("guest");
  });
});

describe("duress AUTH-B/F directory failures", () => {
  it("fails closed to guest when directory read fails under active fence", async () => {
    const { duressSessionFence } = await import("./duress/session/fence.js");
    const { issueAccessContext } = await import("./duress/access/context.js");
    const directory = await import("./local-directory.js");
    duressSessionFence.activate({
      incidentId: "i-dir-fail",
      policyRevision: 1,
      keyEpoch: 1,
      denyOperations: ["manage_grants"],
      admittedCompartmentRefs: ["c1"],
    });
    const ctx = issueAccessContext({
      principalRef: "p1",
      tenantRef: null,
      vaultRef: tomb,
      compartmentRefs: ["c1"],
      deviceBindingRef: "d1",
      presentation: "restricted",
      authorizationCeiling: [],
      denyOperations: ["manage_grants"],
      policyRevision: 1,
      incidentEpoch: duressSessionFence.readFence().incidentEpoch,
      keyEpoch: 1,
      sessionGeneration: duressSessionFence.guard.generation,
      profileId: "p",
      evidenceDigest: "digest0123456789ab",
    });
    duressSessionFence.setContext(ctx);
    const spy = vi
      .spyOn(directory, "readLocalDirectory")
      .mockRejectedValue(new Error("directory unavailable"));
    try {
      expect(await resolveCurrentAccessRole(tomb)).toBe("guest");
    } finally {
      spy.mockRestore();
      const ids = [...duressSessionFence.readFence().activeIncidentIds];
      if (ids.length > 0) {
        duressSessionFence.resolve(
          ids,
          true,
          duressSessionFence.readFence().incidentEpoch,
        );
      }
    }
  });
});
