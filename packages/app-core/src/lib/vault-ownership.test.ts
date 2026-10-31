import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { changeLocalDirectory } from "./local-directory-admin.js";
import {
  GUEST_PERSON_ID,
  GUEST_PERSON_NAME,
} from "./local-directory-bootstrap.js";
import { readLocalDirectory } from "./local-directory.js";
import {
  ownershipRecipients,
  transferRecipients,
  transferVaultOwnership,
  vaultOwners,
} from "./vault-ownership.js";
import { lockAllTombs, unlockTomb } from "./vfs.js";

let tomb: string;
beforeEach(async () => {
  tomb = `vault-ownership-${crypto.randomUUID()}`;
  const { vaultKey } = await mintVaultKey();
  unlockTomb(tomb, vaultKey);
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
});
afterEach(() => {
  lockAllTombs();
  vi.unstubAllGlobals();
});

type Change = Parameters<typeof changeLocalDirectory>[2];

async function build() {
  let dir = await changeLocalDirectory(tomb, 0, {
    action: "create",
    kind: "organization",
    name: "Home",
  });
  const apply = async (change: Change) => {
    dir = await changeLocalDirectory(tomb, dir.revision, change);
    return dir;
  };
  const named = (name: string) => {
    const found = dir.entries.find((entry) => entry.name === name);
    if (!found) throw new Error(`${name} missing`);
    return found;
  };
  const org = named("Home");
  await apply({ action: "create", kind: "person", name: "Ada" });
  await apply({ action: "create", kind: "person", name: "Grace" });
  await apply({ action: "create", kind: "person", name: "Off" });
  await apply({ action: "create", kind: "agent", name: "bot" });
  await apply({
    action: "create",
    kind: "person",
    name: GUEST_PERSON_NAME,
    id: GUEST_PERSON_ID,
  });
  const ada = named("Ada");
  const grace = named("Grace");
  const off = named("Off");
  await apply({
    action: "membership",
    organizationId: org.id,
    principalId: ada.id,
    role: "owner",
  });
  await apply({
    action: "membership",
    organizationId: org.id,
    principalId: grace.id,
    role: "member",
  });
  await apply({
    action: "update",
    id: off.id,
    name: "Off",
    enabled: false,
  });
  return { org, ada, grace, off, bot: named("bot") };
}

describe("vault ownership transfer", () => {
  it("offers only registered users: no guest, agent, disabled person or the owner", async () => {
    const s = await build();
    const dir = await readLocalDirectory(tomb);
    expect(vaultOwners(dir).map((e) => e.id)).toEqual([s.ada.id]);
    expect(ownershipRecipients(dir, s.ada.id).map((e) => e.name)).toEqual([
      "Grace",
    ]);
  });

  it("makes the recipient owner and leaves the previous owner an admin", async () => {
    const s = await build();
    const after = await transferVaultOwnership(tomb, s.grace.id);
    const role = (id: string) =>
      after.memberships.find(
        (row) => row.organizationId === s.org.id && row.principalId === id,
      )?.role;
    expect(role(s.grace.id)).toBe("owner");
    expect(role(s.ada.id)).toBe("admin");
  });

  it("refuses a guest, an agent, a disabled person, an unknown id and the owner", async () => {
    const s = await build();
    for (const id of [
      GUEST_PERSON_ID,
      s.bot.id,
      s.off.id,
      "local_00000000-0000-4000-8000-0000000000ff",
      s.ada.id,
    ]) {
      await expect(transferVaultOwnership(tomb, id)).rejects.toThrow();
    }
    const dir = await readLocalDirectory(tomb);
    expect(vaultOwners(dir).map((e) => e.id)).toEqual([s.ada.id]);
  });

  it("offers the vault's other registered users to its owner", async () => {
    const s = await build();
    const dir = await readLocalDirectory(tomb);
    expect((await transferRecipients(tomb, dir)).map((e) => e.name)).toEqual([
      "Grace",
    ]);
    // With no local person signed in the custodian acts, and the sole owner
    // stands in for them: after the transfer that is Grace, who may name Ada.
    const after = await transferVaultOwnership(tomb, s.grace.id);
    expect(vaultOwners(after).map((e) => e.id)).toEqual([s.grace.id]);
    expect((await transferRecipients(tomb, after)).map((e) => e.id)).toContain(
      s.ada.id,
    );
  });

  it("lets the guest-named owner of an accountless vault hand it to a registered user", async () => {
    let dir = await changeLocalDirectory(tomb, 0, {
      action: "create",
      kind: "organization",
      name: "Home",
    });
    const org = dir.entries.find((e) => e.name === "Home");
    if (!org) throw new Error("org missing");
    dir = await changeLocalDirectory(tomb, dir.revision, {
      action: "create",
      kind: "person",
      name: GUEST_PERSON_NAME,
      id: GUEST_PERSON_ID,
    });
    dir = await changeLocalDirectory(tomb, dir.revision, {
      action: "membership",
      organizationId: org.id,
      principalId: GUEST_PERSON_ID,
      role: "owner",
    });
    dir = await changeLocalDirectory(tomb, dir.revision, {
      action: "create",
      kind: "person",
      name: "Grace",
    });
    const grace = dir.entries.find((e) => e.name === "Grace");
    if (!grace) throw new Error("grace missing");

    expect((await transferRecipients(tomb, dir)).map((e) => e.name)).toEqual([
      "Grace",
    ]);
    const after = await transferVaultOwnership(tomb, grace.id);
    const role = (id: string) =>
      after.memberships.find(
        (row) => row.organizationId === org.id && row.principalId === id,
      )?.role;
    expect(role(grace.id)).toBe("owner");
    expect(role(GUEST_PERSON_ID)).not.toBe("owner");
  });
});
