/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDefaultAccess } from "./local-access-bootstrap.js";
import { readLocalApplications } from "./local-applications.js";
import { readLocalDevices, thisDeviceId } from "./local-devices.js";
import {
  GUEST_PERSON_ID,
  GUEST_PERSON_NAME,
  PAGES_APPLICATION_ID,
  SUPPORT_AGENT_ID,
  readLocalDirectory,
} from "./local-directory.js";
import { listLocalShares } from "./local-share-grants.js";
import { mintVaultKey } from "./vault/crypto.js";
import { lockAllTombs, unlockTomb } from "./vfs.js";

let tomb: string;

beforeEach(async () => {
  tomb = `access-bootstrap-${crypto.randomUUID()}`;
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
  vi.stubGlobal("sessionStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
});

afterEach(() => {
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ensureDefaultAccess", () => {
  it("seeds person, guest, app, device, Pages scopes, and standing vault shares", async () => {
    await ensureDefaultAccess(tomb);

    const directory = await readLocalDirectory(tomb);
    const person = directory.entries.find(
      (row) => row.kind === "person" && row.id !== GUEST_PERSON_ID,
    );
    const guest = directory.entries.find((row) => row.id === GUEST_PERSON_ID);
    expect(person).toBeTruthy();
    expect(guest).toEqual(
      expect.objectContaining({
        kind: "person",
        name: GUEST_PERSON_NAME,
        id: GUEST_PERSON_ID,
      }),
    );
    expect(
      directory.entries.some((row) => row.id === PAGES_APPLICATION_ID),
    ).toBe(true);
    expect(directory.entries.some((row) => row.id === SUPPORT_AGENT_ID)).toBe(
      true,
    );
    expect(
      directory.memberships.some(
        (row) => row.principalId === GUEST_PERSON_ID && row.role === "member",
      ),
    ).toBe(true);

    const devices = await readLocalDevices(tomb);
    expect(devices.some((row) => row.id === thisDeviceId())).toBe(true);

    const pages = (await readLocalApplications(tomb)).applications.find(
      (row) => row.applicationId === PAGES_APPLICATION_ID,
    );
    expect(pages?.scopes).toEqual(["openid", "profile", "records:read"]);
    expect(
      pages?.scopeRoles?.find((row) => row.scope === "records:read"),
    ).toEqual({
      scope: "records:read",
      roles: ["owner"],
    });

    const shares = await listLocalShares(tomb);
    expect(
      shares.some(
        (share) =>
          share.principalId === person?.id &&
          share.resourceKind === "vault" &&
          share.policy === "items",
      ),
    ).toBe(true);
    expect(
      shares.some(
        (share) =>
          share.principalId === GUEST_PERSON_ID &&
          share.resourceKind === "vault" &&
          share.resourceId === "guest" &&
          share.policy === "open",
      ),
    ).toBe(true);
    expect(
      shares.some(
        (share) =>
          share.principalId === GUEST_PERSON_ID &&
          share.resourceKind === "vault" &&
          share.resourceId === "guest" &&
          share.policy === "items",
      ),
    ).toBe(true);
    expect(
      shares.some(
        (share) =>
          share.principalId === SUPPORT_AGENT_ID &&
          share.resourceKind === "vault" &&
          share.policy === "open",
      ),
    ).toBe(true);

    const before = shares.length;
    await ensureDefaultAccess(tomb);
    expect(await listLocalShares(tomb)).toHaveLength(before);
  });
});
