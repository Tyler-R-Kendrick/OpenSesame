import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  listRecordedLocalGrants,
  revokeRecordedLocalGrant,
} from "./local-grant-admin.js";
import {
  type LocalGrantRecord,
  readLocalGrantRecords,
  writeLocalGrantRecords,
} from "./local-grant-store.js";
import { mintVaultKey } from "./vault/crypto.js";
import {
  lockAllTombs,
  lockTomb,
  readFile,
  unlockTomb,
  vfsSeams,
  writeFile,
} from "./vfs.js";

let tomb: string;
let records: LocalGrantRecord[];
beforeEach(async () => {
  tomb = `grant-admin-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  let queue = Promise.resolve();
  vi.stubGlobal("navigator", {
    locks: {
      request: <T>(_name: string, action: () => Promise<T>) => {
        const next = queue.then(action);
        queue = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    },
  });
  const now = Date.now();
  records = [0, 1].map((index) => ({
    id: crypto.randomUUID(),
    principalId: `local-person-${index}`,
    sessionId: `session-${index}`,
    applicationId: `app-${index}`,
    organizationId: `org-${index}`,
    applicationRevision: 1,
    redirectUri: "https://rp.example.test/callback",
    scopes: ["openid"],
    nonce: "n".repeat(43),
    issuedAt: now,
    expiresAt: now + 60_000,
    approval: { principalId: "local-approver", sessionId: "human-session" },
  }));
  await writeLocalGrantRecords(tomb, records);
});
afterEach(() => {
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("returns only display-safe unexpired records, never presenting them as authority", async () => {
  const rows = await listRecordedLocalGrants(tomb);
  expect(rows).toHaveLength(2);
  expect(Object.keys(rows[0]).sort()).toEqual([
    "applicationId",
    "approvingPrincipalId",
    "expiresAt",
    "id",
    "issuedAt",
    "organizationId",
    "principalId",
    "scopes",
  ]);
  expect(JSON.stringify(rows)).not.toContain("human-session");
  vi.spyOn(Date, "now").mockReturnValue(records[0].expiresAt);
  expect(await listRecordedLocalGrants(tomb)).toEqual([]);
});

it("serializes concurrent revocations without losing unrelated writes", async () => {
  await Promise.all(
    records.map((row) => revokeRecordedLocalGrant(tomb, row.id)),
  );
  expect(await readLocalGrantRecords(tomb)).toEqual([]);
});

it("scopes revocation to its vault and exact ID", async () => {
  const other = `other-${crypto.randomUUID()}`;
  unlockTomb(other, (await mintVaultKey()).vaultKey);
  await writeLocalGrantRecords(other, records);
  await revokeRecordedLocalGrant(tomb, records[0].id);
  expect(await readLocalGrantRecords(tomb)).toEqual([records[1]]);
  expect(await readLocalGrantRecords(other)).toEqual(records);
  await expect(revokeRecordedLocalGrant(tomb, records[0].id)).rejects.toThrow();
});

it("refuses locked reads and mutations, preserving encrypted data", async () => {
  lockTomb(tomb);
  await expect(listRecordedLocalGrants(tomb)).rejects.toThrow();
  await expect(revokeRecordedLocalGrant(tomb, records[0].id)).rejects.toThrow();
});

it("does not report success or rewrite corrupt data when persistence fails", async () => {
  const before = await readFile(tomb, "config/identity-grants");
  const write = vi
    .spyOn(vfsSeams, "writeRaw")
    .mockRejectedValueOnce(new Error("Storage unavailable"));
  await expect(revokeRecordedLocalGrant(tomb, records[0].id)).rejects.toThrow();
  write.mockRestore();
  expect(await readFile(tomb, "config/identity-grants")).toEqual(before);
  const invalid = new TextEncoder().encode(
    '{"version":2,"grants":[{"id":"bad"}]}',
  );
  await writeFile(tomb, "config/identity-grants", invalid);
  await expect(listRecordedLocalGrants(tomb)).rejects.toThrow();
  await expect(revokeRecordedLocalGrant(tomb, records[0].id)).rejects.toThrow();
  expect(await readFile(tomb, "config/identity-grants")).toEqual(invalid);
});
