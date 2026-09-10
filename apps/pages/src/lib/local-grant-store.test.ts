import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  type LocalGrantRecord,
  readLocalGrantRecords,
  writeLocalGrantRecords,
} from "./local-grant-store.js";
import { mintVaultKey } from "./vault/crypto.js";
import { lockAllTombs, readFile, unlockTomb, writeFile } from "./vfs.js";

let tomb: string;
const path = "config/identity-grants";
const record: LocalGrantRecord = {
  id: "grant-id",
  principalId: "local-person",
  sessionId: "session-id",
  applicationId: "application-id",
  organizationId: "organization-id",
  applicationRevision: 1,
  redirectUri: "https://rp.example.test/callback",
  scopes: ["openid"],
  nonce: "abcdefghijklmnopqrstuv",
  issuedAt: 1000,
  expiresAt: 2000,
};
beforeEach(async () => {
  tomb = `grant-migration-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
});
afterEach(lockAllTombs);
async function seed(version: number, grant: BoundaryValue) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ version, grants: [grant] }),
  );
  await writeFile(tomb, path, bytes);
  return bytes;
}

it("reads legacy person grants without rewriting and upgrades on a later mutation", async () => {
  const bytes = await seed(1, record);
  expect(await readLocalGrantRecords(tomb)).toEqual([record]);
  expect(await readFile(tomb, path)).toEqual(bytes);
  await writeLocalGrantRecords(tomb, [record]);
  expect(
    JSON.parse(new TextDecoder().decode(await readFile(tomb, path))),
  ).toEqual({ version: 2, grants: [record] });
  expect(await readLocalGrantRecords(tomb)).toEqual([record]);
});

it("round-trips both human approval bindings in the new ledger", async () => {
  const approved = {
    ...record,
    approval: { principalId: "local-approver", sessionId: "human-session" },
  };
  await writeLocalGrantRecords(tomb, [approved]);
  expect(await readLocalGrantRecords(tomb)).toEqual([approved]);
  await seed(1, approved);
  await expect(readLocalGrantRecords(tomb)).rejects.toThrow();
});

it.each([
  { principalId: "local-human" },
  { sessionId: "human-session" },
  { principalId: "local-human", sessionId: "human-session", role: "owner" },
  null,
  "human-session",
])(
  "refuses malformed approval evidence without deleting stored bytes: %j",
  async (approval) => {
    const bytes = await seed(2, { ...record, approval });
    await expect(readLocalGrantRecords(tomb)).rejects.toThrow();
    expect(await readFile(tomb, path)).toEqual(bytes);
  },
);
