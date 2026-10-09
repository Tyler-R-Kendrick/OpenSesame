/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readLocalDirectory } from "./local-directory.js";
import { localRequestFixture } from "./local-request.fixture.js";
import {
  approvePendingShare,
  denyPendingShare,
  listPendingShares,
  listShareTargets,
  submitLocalShare,
} from "./local-share-grants-approvals.js";
import {
  createLocalShare,
  grantIdentities,
  listLocalShares,
  revokeLocalShare,
} from "./local-share-grants.js";
import { shareAllows } from "./local-share-reach.js";
import { lockAllTombs, writeFile } from "./vfs.js";

beforeEach(() => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
});
afterEach(() => {
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("grants a vault to a person and lists it until revoked", async () => {
  const fixture = await localRequestFixture();
  const shares = await createLocalShare(fixture.tomb, {
    principalId: fixture.personId,
    resourceKind: "vault",
    resourceId: "personal",
    resourceLabel: "personal",
    policy: "open",
    durationSeconds: 3600,
  });
  expect(shares).toHaveLength(1);
  expect(shares[0]?.resourceKind).toBe("vault");
  expect(await listLocalShares(fixture.tomb)).toHaveLength(1);
  await revokeLocalShare(fixture.tomb, shares[0]?.id ?? "");
  expect(await listLocalShares(fixture.tomb)).toHaveLength(0);
});

it("grants a connector under the invoke policy", async () => {
  const fixture = await localRequestFixture();
  const github = listShareTargets().find(
    (target) => target.kind === "connection" && target.id === "github",
  );
  if (!github) throw new Error("missing connector");
  const shares = await createLocalShare(fixture.tomb, {
    principalId: fixture.personId,
    resourceKind: "connection",
    resourceId: github.id,
    resourceLabel: github.label,
    policy: "invoke",
    durationSeconds: 86400,
  });
  expect(shares[0]?.policy).toBe("invoke");
  expect(shares[0]?.resourceId).toBe("github");
});

/** A trail that refuses every entry: corrupt, so each append fails to read it. */
async function breakAccessTrail(tomb: string): Promise<void> {
  await writeFile(tomb, "config/access-audit", new TextEncoder().encode("{}"));
}

it("a connector grant stands when the trail will not take its entry", async () => {
  const fixture = await localRequestFixture();
  await breakAccessTrail(fixture.tomb);
  const shares = await createLocalShare(fixture.tomb, {
    principalId: fixture.personId,
    resourceKind: "connection",
    resourceId: "github",
    resourceLabel: "GitHub",
    policy: "invoke",
    durationSeconds: 86400,
  });
  expect(shares).toHaveLength(1);
  expect(await listLocalShares(fixture.tomb)).toHaveLength(1);
});

it("a connector revoke the trail will not record leaves the share for a retry", async () => {
  const fixture = await localRequestFixture();
  const [share] = await createLocalShare(fixture.tomb, {
    principalId: fixture.personId,
    resourceKind: "connection",
    resourceId: "github",
    resourceLabel: "GitHub",
    policy: "invoke",
    durationSeconds: 86400,
  });
  if (!share) throw new Error("expected a share");
  await breakAccessTrail(fixture.tomb);
  await expect(revokeLocalShare(fixture.tomb, share.id)).rejects.toThrow(
    /corrupt/,
  );
  expect((await listLocalShares(fixture.tomb)).map((row) => row.id)).toEqual([
    share.id,
  ]);
});

it("lists folder and item targets the open vault names", () => {
  const targets = listShareTargets({
    folders: [
      { id: "fold-1", label: "Work" },
      { id: "", label: "blank" },
      { id: "x".repeat(129), label: "too long" },
    ],
    items: [{ id: "item-1", label: `  ${"n".repeat(200)}` }],
  });
  expect(targets.filter((row) => row.kind === "folder")).toEqual([
    { kind: "folder", id: "fold-1", label: "Work" },
  ]);
  const item = targets.find((row) => row.kind === "item");
  expect(item?.id).toBe("item-1");
  expect(item?.label).toHaveLength(128);
});

it("holds an application grant until it is approved", async () => {
  const fixture = await localRequestFixture();
  const directory = await readLocalDirectory(fixture.tomb);
  expect(grantIdentities(directory.entries).map((row) => row.kind)).toEqual([
    "person",
    "application",
  ]);
  const input = {
    principalId: fixture.applicationId,
    resourceKind: "folder" as const,
    resourceId: "fold-1",
    resourceLabel: "Work",
    policy: "read",
    durationSeconds: 3600,
  };
  await expect(createLocalShare(fixture.tomb, input)).rejects.toThrow(
    /Approve the grant/,
  );
  const submitted = await submitLocalShare(fixture.tomb, input);
  expect(submitted.outcome).toBe("pending");
  expect(
    await shareAllows(
      fixture.tomb,
      { kind: "folder", id: "fold-1" },
      "read",
      fixture.applicationId,
    ),
  ).toBe(false);
  if (submitted.outcome !== "pending") return;
  const shares = await approvePendingShare(fixture.tomb, submitted.pending.id);
  expect(shares.some((share) => share.principalId === fixture.applicationId)).toBe(
    true,
  );
  expect(await listPendingShares(fixture.tomb)).toEqual([]);
  expect(
    await shareAllows(
      fixture.tomb,
      { kind: "folder", id: "fold-1" },
      "read",
      fixture.applicationId,
    ),
  ).toBe(true);
  expect(
    await shareAllows(
      fixture.tomb,
      { kind: "folder", id: "fold-1" },
      "write",
      fixture.applicationId,
    ),
  ).toBe(false);
  expect(
    await shareAllows(
      fixture.tomb,
      { kind: "item", id: "item-1", folderId: "fold-1" },
      "read",
      fixture.applicationId,
    ),
  ).toBe(true);
  expect(
    await shareAllows(
      fixture.tomb,
      { kind: "item", id: "item-2", folderId: "other" },
      "read",
      fixture.applicationId,
    ),
  ).toBe(false);
});

it("covers an item grant only for that item", async () => {
  const fixture = await localRequestFixture();
  const submitted = await submitLocalShare(fixture.tomb, {
    principalId: fixture.applicationId,
    resourceKind: "item",
    resourceId: "item-1",
    resourceLabel: "Work / API key",
    policy: "use",
    durationSeconds: 3600,
  });
  if (submitted.outcome !== "pending") throw new Error("expected pending");
  await approvePendingShare(fixture.tomb, submitted.pending.id);
  expect(
    await shareAllows(
      fixture.tomb,
      { kind: "item", id: "item-1", folderId: "fold-1" },
      "write",
      fixture.applicationId,
    ),
  ).toBe(true);
  expect(
    await shareAllows(
      fixture.tomb,
      { kind: "item", id: "item-2", folderId: "fold-1" },
      "write",
      fixture.applicationId,
    ),
  ).toBe(false);
});

async function agentNamed(tomb: string, name: string) {
  const directory = await readLocalDirectory(tomb);
  const agent = directory.entries.find(
    (row) => row.kind === "agent" && row.name === name,
  );
  if (!agent) throw new Error(`missing agent ${name}`);
  return agent;
}

it("holds an agent grant until it is approved", async () => {
  const fixture = await localRequestFixture();
  await fixture.change({ action: "create", kind: "agent", name: "Helper" });
  const agent = await agentNamed(fixture.tomb, "Helper");
  const input = {
    principalId: agent.id,
    resourceKind: "item" as const,
    resourceId: "item-1",
    resourceLabel: "Work / API key",
    policy: "use",
    durationSeconds: 3600,
  };
  await expect(createLocalShare(fixture.tomb, input)).rejects.toThrow(
    /Approve the grant/,
  );
  const first = await submitLocalShare(fixture.tomb, input);
  const second = await submitLocalShare(fixture.tomb, input);
  expect(first.outcome).toBe("pending");
  expect(second.outcome).toBe("pending");
  if (first.outcome !== "pending" || second.outcome !== "pending") return;
  expect(second.pending.id).toBe(first.pending.id);
  expect(
    (await listLocalShares(fixture.tomb)).some(
      (share) => share.principalId === agent.id,
    ),
  ).toBe(false);
  await denyPendingShare(fixture.tomb, first.pending.id);
  expect(await listPendingShares(fixture.tomb)).toEqual([]);
  const again = await submitLocalShare(fixture.tomb, input);
  if (again.outcome !== "pending") throw new Error("expected pending");
  const shares = await approvePendingShare(fixture.tomb, again.pending.id);
  expect(shares.some((share) => share.principalId === agent.id)).toBe(true);
  expect(await listPendingShares(fixture.tomb)).toEqual([]);
  expect(shares[0]?.expiresAt).toBe(1788998400000 + 3600 * 1000);
});

it("refuses a grant to a disabled agent", async () => {
  const fixture = await localRequestFixture();
  await fixture.change({ action: "create", kind: "agent", name: "Helper" });
  const agent = await agentNamed(fixture.tomb, "Helper");
  await fixture.change({
    action: "update",
    id: agent.id,
    name: agent.name,
    enabled: false,
  });
  await expect(
    submitLocalShare(fixture.tomb, {
      principalId: agent.id,
      resourceKind: "vault",
      resourceId: "personal",
      resourceLabel: "personal",
      policy: "open",
      durationSeconds: 3600,
    }),
  ).rejects.toThrow(/disabled/);
});
