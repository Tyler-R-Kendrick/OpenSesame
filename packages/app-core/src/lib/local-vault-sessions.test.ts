/** @vitest-environment jsdom */

import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDefaultAccess } from "./local-access-bootstrap.js";
import { ensureOwnerPerson } from "./local-directory-bootstrap.js";
import { changeLocalDirectory } from "./local-directory.js";
import { mintGuestSessionPerson } from "./local-guest.js";
import { listLocalShares } from "./local-share-grants.js";
import {
  createVaultSession,
  redeemVaultSessionCode,
  restartVaultSession,
  startVaultSession,
  stopVaultSession,
} from "./local-vault-sessions.js";
import { vaultStore } from "./vault/store.js";
import { lockAllTombs, unlockTomb } from "./vfs.js";

let tomb: string;

beforeEach(async () => {
  tomb = `vault-session-${crypto.randomUUID()}`;
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
  vi.stubGlobal("location", {
    origin: "http://localhost:5180",
    href: "http://localhost:5180/",
  });
  vi.stubGlobal("isSecureContext", true);
  const memory = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
    clear: () => {
      memory.clear();
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
  await ensureDefaultAccess(tomb);
});

afterEach(() => {
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("local vault sessions", () => {
  it("starts with a join code, issues grants, stop revokes, restart reissues", async () => {
    const guest = mintGuestSessionPerson();
    const directory = await ensureOwnerPerson(tomb, "Ada");
    await changeLocalDirectory(tomb, directory.revision, {
      action: "create",
      kind: "person",
      name: guest.name,
      id: guest.id,
    });
    const session = await createVaultSession(tomb, {
      label: "Pairing",
      durationSeconds: 3600,
      start: true,
      grants: [
        {
          subject: { kind: "accessRole", role: "guest" },
          resourceKind: "vault",
          resourceId: tomb,
          resourceLabel: "this vault",
          policy: "open",
        },
        {
          subject: { kind: "principal", principalId: guest.id },
          resourceKind: "item",
          resourceId: "row-1",
          resourceLabel: "Row one",
          policy: "read",
        },
      ],
    });
    expect(session.status).toBe("running");
    expect(session.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(session.boundTomb).toBe(tomb);

    const runningShares = await listLocalShares(tomb);
    expect(
      runningShares.filter((share) => share.sessionId === session.id).length,
    ).toBeGreaterThan(0);

    await stopVaultSession(tomb, session.id);
    expect(
      (await listLocalShares(tomb)).filter(
        (share) => share.sessionId === session.id,
      ),
    ).toHaveLength(0);

    const restarted = await restartVaultSession(tomb, session.id);
    expect(restarted.status).toBe("running");
    expect(restarted.code).toBe(session.code);
    expect(
      (await listLocalShares(tomb)).some(
        (share) => share.sessionId === session.id,
      ),
    ).toBe(true);
  });

  it("redeems a running session code for a principal mid-run", async () => {
    const guest = mintGuestSessionPerson();
    const directory = await ensureOwnerPerson(tomb, "Ada");
    await changeLocalDirectory(tomb, directory.revision, {
      action: "create",
      kind: "person",
      name: guest.name,
      id: guest.id,
    });
    const session = await createVaultSession(tomb, {
      label: "Join me",
      durationSeconds: 3600,
      start: true,
      grants: [
        {
          subject: { kind: "accessRole", role: "guest" },
          resourceKind: "vault",
          resourceId: tomb,
          resourceLabel: "this vault",
          policy: "open",
        },
      ],
    });
    await stopVaultSession(tomb, session.id);
    await startVaultSession(tomb, session.id);
    const joined = await redeemVaultSessionCode(
      tomb,
      session.code.toLowerCase(),
      guest.id,
    );
    expect(joined.status).toBe("running");
    expect(
      (await listLocalShares(tomb)).some(
        (share) =>
          share.sessionId === session.id &&
          share.principalId === guest.id &&
          share.resourceKind === "vault",
      ),
    ).toBe(true);
  });
});
