/** @vitest-environment jsdom */

import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordAccessAuditEvent } from "./local-access-audit.js";
import { ensureDefaultAccess } from "./local-access-bootstrap.js";
import { readLocalApplications } from "./local-applications.js";
import { readLocalDevices, thisDeviceId } from "./local-devices.js";
import {
  PAGES_APPLICATION_ID,
  SUPPORT_AGENT_ID,
} from "./local-directory-bootstrap.js";
import { readLocalDirectory } from "./local-directory.js";
import { mintGuestSessionPerson } from "./local-guest.js";
import {
  type LocalShare,
  createLocalShare,
  listLocalShares,
  revokeLocalShare,
} from "./local-share-grants.js";
import { GUEST_TOMB, lockAllTombs, unlockTomb } from "./vfs.js";

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
});

afterEach(() => {
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ensureDefaultAccess", () => {
  it("seeds person, app, device, Pages scopes, and standing vault shares", async () => {
    await ensureDefaultAccess(tomb);

    const directory = await readLocalDirectory(tomb);
    const person = directory.entries.find((row) => row.kind === "person");
    expect(person).toBeTruthy();
    // Personal Access bootstrap does not mint a shared guest account.
    expect(
      directory.entries.filter((row) => row.kind === "person"),
    ).toHaveLength(1);
    expect(
      directory.entries.some((row) => row.id === PAGES_APPLICATION_ID),
    ).toBe(true);
    expect(directory.entries.some((row) => row.id === SUPPORT_AGENT_ID)).toBe(
      true,
    );

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
          share.principalId === SUPPORT_AGENT_ID &&
          share.resourceKind === "vault" &&
          share.policy === "open",
      ),
    ).toBe(true);

    const before = shares.length;
    await ensureDefaultAccess(tomb);
    expect(await listLocalShares(tomb)).toHaveLength(before);
  });

  it("mints a unique guest-N into the guest tomb only", async () => {
    const guest = mintGuestSessionPerson();
    unlockTomb(GUEST_TOMB, (await mintVaultKey()).vaultKey);
    await ensureDefaultAccess(GUEST_TOMB);
    const directory = await readLocalDirectory(GUEST_TOMB);
    const people = directory.entries.filter((row) => row.kind === "person");
    expect(people).toEqual([
      expect.objectContaining({ id: guest.id, name: guest.name }),
    ]);
    expect(guest.name).toMatch(/^guest-[1-9]\d*$/);
    const shares = await listLocalShares(GUEST_TOMB);
    expect(
      shares.some(
        (share) =>
          share.principalId === guest.id &&
          share.resourceKind === "vault" &&
          share.resourceId === "guest",
      ),
    ).toBe(true);
  });

  it("keeps a standing connector grant revoked on Access, for that principal only", async () => {
    await ensureDefaultAccess(tomb);
    const connector = (shares: LocalShare[]) =>
      shares.filter((share) => share.resourceKind === "connection");
    const standing = connector(await listLocalShares(tomb));
    const agentGrant = standing.find(
      (share) => share.principalId === SUPPORT_AGENT_ID,
    );
    expect(agentGrant).toBeTruthy();
    const provider = agentGrant?.resourceId ?? "";
    const ownerGrant = standing.find(
      (share) =>
        share.resourceId === provider && share.principalId !== SUPPORT_AGENT_ID,
    );
    expect(ownerGrant).toBeTruthy();

    await revokeLocalShare(tomb, agentGrant?.id ?? "");
    await ensureDefaultAccess(tomb);

    const after = connector(await listLocalShares(tomb)).filter(
      (share) => share.resourceId === provider,
    );
    // The support agent stays revoked; the owner's grant is untouched.
    expect(after.map((share) => share.principalId)).toEqual([
      ownerGrant?.principalId,
    ]);
  });

  it("renews a revoked standing grant again once a person re-grants it", async () => {
    await ensureDefaultAccess(tomb);
    const agentGrant = (await listLocalShares(tomb)).find(
      (share) =>
        share.resourceKind === "connection" &&
        share.principalId === SUPPORT_AGENT_ID,
    );
    const provider = agentGrant?.resourceId ?? "";
    await revokeLocalShare(tomb, agentGrant?.id ?? "");
    await createLocalShare(tomb, {
      principalId: SUPPORT_AGENT_ID,
      resourceKind: "connection",
      resourceId: provider,
      resourceLabel: provider,
      policy: "use",
      durationSeconds: 3600,
    });
    // The one-hour grant is inside the renewal window, so the standing
    // grant replaces it now that the trail's newest word is a grant.
    await ensureDefaultAccess(tomb);
    const renewed = (await listLocalShares(tomb)).find(
      (share) =>
        share.resourceId === provider && share.principalId === SUPPORT_AGENT_ID,
    );
    expect(renewed?.expiresAt ?? 0).toBeGreaterThan(Date.now() + 86400_000);
  });

  it("does not read a revocation that names no principal as covering the standing grants", async () => {
    // Learn which providers get standing grants, in a scratch tomb.
    const scratch = `access-bootstrap-probe-${crypto.randomUUID()}`;
    unlockTomb(scratch, (await mintVaultKey()).vaultKey);
    await ensureDefaultAccess(scratch);
    const providers = new Set(
      (await listLocalShares(scratch))
        .filter((share) => share.resourceKind === "connection")
        .map((share) => share.resourceId),
    );
    expect(providers.size).toBeGreaterThan(0);

    // What revokeLocalShare wrote before it recorded whose grant it was —
    // e.g. a guest's hand-made grant, revoked long ago.
    for (const provider of providers)
      await recordAccessAuditEvent(tomb, {
        eventType: "access.connection.revoked",
        outcome: "succeeded",
        targetType: "connection",
        targetId: provider,
        metadata: { providerId: provider, action: "revoke", kind: "share" },
      });
    await ensureDefaultAccess(tomb);
    const issued = new Set(
      (await listLocalShares(tomb))
        .filter((share) => share.resourceKind === "connection")
        .map((share) => share.resourceId),
    );
    expect(issued).toEqual(providers);
  });
});
