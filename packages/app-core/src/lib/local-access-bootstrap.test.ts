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
  approvePendingShare,
  submitLocalShare,
} from "./local-share-grants-approvals.js";
import {
  type LocalShare,
  createLocalShare,
  listLocalShares,
  revokeLocalShare,
} from "./local-share-grants.js";
import { flushSharingReceipts } from "./sharing-receipts.js";
import { wipeTombOnDestroy } from "./vault/tomb-migration.js";
import {
  GUEST_TOMB,
  lockAllTombs,
  unlockTomb,
  vfsFlush,
  writeFile,
} from "./vfs.js";

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
          share.resourceKind === "connection" &&
          share.principalId === person?.id &&
          share.policy === "invoke",
      ),
    ).toBe(true);
    // The built-in agent is in the directory and holds no standing grant.
    expect(shares.some((share) => share.principalId === SUPPORT_AGENT_ID)).toBe(
      false,
    );

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
    const owner = (await readLocalDirectory(tomb)).entries.find(
      (row) => row.kind === "person",
    );
    const ownerGrant = standing.find(
      (share) => share.principalId === owner?.id && share.policy === "invoke",
    );
    expect(ownerGrant).toBeTruthy();
    const provider = ownerGrant?.resourceId ?? "";
    await createLocalShare(tomb, {
      principalId: PAGES_APPLICATION_ID,
      resourceKind: "connection",
      resourceId: provider,
      resourceLabel: provider,
      policy: "use",
      durationSeconds: 3600,
    });

    await revokeLocalShare(tomb, ownerGrant?.id ?? "");
    await ensureDefaultAccess(tomb);

    const after = connector(await listLocalShares(tomb)).filter(
      (share) => share.resourceId === provider,
    );
    // The owner's standing grant stays revoked; the application's does not.
    expect(after.map((share) => share.principalId)).toEqual([
      PAGES_APPLICATION_ID,
    ]);
  });

  it("never re-issues a revoked grant when the trail that says so cannot be read", async () => {
    await ensureDefaultAccess(tomb);
    const ownerId = (await readLocalDirectory(tomb)).entries.find(
      (row) => row.kind === "person",
    )?.id;
    const [ownerGrant] = (await listLocalShares(tomb)).filter(
      (share) =>
        share.resourceKind === "connection" &&
        share.principalId === ownerId &&
        share.policy === "invoke",
    );
    const provider = ownerGrant?.resourceId ?? "";
    const grantOf = async () =>
      (await listLocalShares(tomb)).filter(
        (share) =>
          share.resourceKind === "connection" &&
          share.resourceId === provider &&
          share.principalId === ownerId,
      );
    await revokeLocalShare(tomb, ownerGrant?.id ?? "");
    expect(await grantOf()).toEqual([]);
    // A build that writes the trail another way, a rollback, a damaged file:
    // this one cannot tell what was revoked, so it issues nothing.
    await writeFile(
      tomb,
      "config/access-audit",
      new TextEncoder().encode(JSON.stringify({ version: 2, events: "?" })),
    );
    await ensureDefaultAccess(tomb);
    expect(await grantOf()).toEqual([]);
  });

  it("grants the standing connector shares again in a vault made after the last was deleted", async () => {
    await ensureDefaultAccess(tomb);
    const ownerId = (await readLocalDirectory(tomb)).entries.find(
      (row) => row.kind === "person",
    )?.id;
    const [ownerGrant] = (await listLocalShares(tomb)).filter(
      (share) =>
        share.resourceKind === "connection" && share.principalId === ownerId,
    );
    await revokeLocalShare(tomb, ownerGrant?.id ?? "");
    // The vault is destroyed and another is made in the same tomb, with a key
    // that cannot open what the first one sealed. Its audit of revocations
    // must not stay behind as ciphertext the new vault reads as "unreadable",
    // which would withhold every standing grant for good. The revoke's
    // receipt writes after revokeLocalShare returns; let it land first.
    await flushSharingReceipts();
    await vfsFlush();
    await wipeTombOnDestroy(tomb);
    unlockTomb(tomb, (await mintVaultKey()).vaultKey);
    await ensureDefaultAccess(tomb);
    const ownerAfter = (await readLocalDirectory(tomb)).entries.find(
      (row) => row.kind === "person",
    )?.id;
    expect(
      (await listLocalShares(tomb)).filter(
        (share) =>
          share.resourceKind === "connection" &&
          share.principalId === ownerAfter,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (await listLocalShares(tomb)).some(
        (share) => share.principalId === SUPPORT_AGENT_ID,
      ),
    ).toBe(false);
  });

  it("renews a revoked standing grant again once a person re-grants it", async () => {
    await ensureDefaultAccess(tomb);
    const ownerGrant = (await listLocalShares(tomb)).find(
      (share) =>
        share.resourceKind === "connection" && share.policy === "invoke",
    );
    const provider = ownerGrant?.resourceId ?? "";
    const ownerId = ownerGrant?.principalId ?? "";
    await revokeLocalShare(tomb, ownerGrant?.id ?? "");
    await createLocalShare(tomb, {
      principalId: ownerId,
      resourceKind: "connection",
      resourceId: provider,
      resourceLabel: provider,
      policy: "invoke",
      durationSeconds: 3600,
    });
    // The one-hour grant is inside the renewal window, so the standing
    // grant replaces it now that the trail's newest word is a grant.
    await ensureDefaultAccess(tomb);
    const renewed = (await listLocalShares(tomb)).find(
      (share) => share.resourceId === provider && share.principalId === ownerId,
    );
    expect(renewed?.expiresAt ?? 0).toBeGreaterThan(Date.now() + 86400_000);
  });

  it("does not widen an approved agent grant into a standing week", async () => {
    await ensureDefaultAccess(tomb);
    const provider =
      (await listLocalShares(tomb)).find(
        (share) => share.resourceKind === "connection",
      )?.resourceId ?? "";
    const submitted = await submitLocalShare(tomb, {
      principalId: SUPPORT_AGENT_ID,
      resourceKind: "connection",
      resourceId: provider,
      resourceLabel: provider,
      policy: "use",
      durationSeconds: 3600,
    });
    expect(submitted.outcome).toBe("pending");
    if (submitted.outcome !== "pending") return;
    await approvePendingShare(tomb, submitted.pending.id);
    const before = (await listLocalShares(tomb)).find(
      (share) => share.principalId === SUPPORT_AGENT_ID,
    );
    await ensureDefaultAccess(tomb);
    const after = (await listLocalShares(tomb)).find(
      (share) => share.principalId === SUPPORT_AGENT_ID,
    );
    expect(after?.expiresAt).toBe(before?.expiresAt);
    expect((after?.expiresAt ?? 0) - (after?.issuedAt ?? 0)).toBe(3600 * 1000);
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
