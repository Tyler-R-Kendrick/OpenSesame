/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GUEST_PERSON_ID,
  changeLocalDirectory,
  ensureOwnerPerson,
  readLocalDirectory,
} from "./local-directory.js";
import {
  accessRoleLabel,
  canAccess,
  hasClaimedOperator,
  resolveAccessRole,
  resolveCurrentAccessRole,
} from "./local-rbac.js";
import { mintVaultKey } from "./vault/crypto.js";
import { vaultStore } from "./vault/store.js";
import { lockAllTombs, unlockTomb } from "./vfs.js";

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
  it("maps owner/admin to Operator and guest@guest to Guest", async () => {
    const directory = await ensureOwnerPerson(tomb, "Ada");
    const owner = directory.entries.find(
      (row) => row.kind === "person" && row.id !== GUEST_PERSON_ID,
    );
    expect(owner).toBeTruthy();
    expect(resolveAccessRole(directory, owner?.id ?? "")).toBe("operator");
    expect(resolveAccessRole(directory, GUEST_PERSON_ID)).toBe("guest");
    expect(hasClaimedOperator(directory)).toBe(true);
    expect(accessRoleLabel("operator")).toBe("Operator");
    expect(canAccess("operator", "manage_grants")).toBe(true);
    expect(canAccess("guest", "manage_grants")).toBe(false);
  });

  it("refuses elevating guest to admin or owner beside a claimed operator", async () => {
    const directory = await ensureOwnerPerson(tomb, "Ada");
    const org = directory.entries.find((row) => row.kind === "organization");
    await expect(
      changeLocalDirectory(tomb, directory.revision, {
        action: "membership",
        organizationId: org?.id ?? "",
        principalId: GUEST_PERSON_ID,
        role: "admin",
      }),
    ).rejects.toThrow(/cannot be operators/i);
  });

  it("lets a sole guest act as operator until a claimed operator exists", async () => {
    await ensureOwnerPerson(tomb, "guest@guest");
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
      tomb,
    });
    expect(await resolveCurrentAccessRole(tomb)).toBe("operator");

    const directory = await readLocalDirectory(tomb);
    const org = directory.entries.find((row) => row.kind === "organization");
    await changeLocalDirectory(tomb, directory.revision, {
      action: "create",
      kind: "person",
      name: "Ada",
    });
    const withAda = await readLocalDirectory(tomb);
    const ada = withAda.entries.find(
      (row) => row.kind === "person" && row.name === "Ada",
    );
    await changeLocalDirectory(tomb, withAda.revision, {
      action: "membership",
      organizationId: org?.id ?? "",
      principalId: ada?.id ?? "",
      role: "owner",
    });
    const next = await readLocalDirectory(tomb);
    expect(hasClaimedOperator(next)).toBe(true);
    expect(
      next.memberships.find((row) => row.principalId === GUEST_PERSON_ID)?.role,
    ).toBe("member");
    expect(await resolveCurrentAccessRole(tomb)).toBe("guest");
  });
});
