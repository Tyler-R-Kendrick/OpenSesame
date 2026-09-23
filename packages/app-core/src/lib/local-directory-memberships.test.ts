import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GUEST_PERSON_ID,
  GUEST_PERSON_NAME,
} from "./local-directory-bootstrap.js";
import {
  type LocalDirectory,
  changeLocalDirectory,
} from "./local-directory.js";
import { lockAllTombs, unlockTomb } from "./vfs.js";

let tomb: string;
beforeEach(async () => {
  tomb = `directory-memberships-${crypto.randomUUID()}`;
  const { vaultKey } = await mintVaultKey();
  unlockTomb(tomb, vaultKey);
  let queue = Promise.resolve();
  vi.stubGlobal("navigator", {
    locks: {
      request: (_name: string, run: () => Promise<LocalDirectory>) => {
        const result = queue.then(run);
        queue = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    },
  });
});
afterEach(() => {
  lockAllTombs();
  vi.unstubAllGlobals();
});

describe("local directory memberships", () => {
  it("demotes guest owners in every org when a claimed operator is promoted", async () => {
    let directory = await changeLocalDirectory(tomb, 0, {
      action: "create",
      kind: "organization",
      name: "Guest org",
    });
    const guestOrg = directory.entries.find(
      (entry) => entry.name === "Guest org",
    );
    expect(guestOrg).toBeDefined();
    if (!guestOrg) throw new Error("guest org missing");
    directory = await changeLocalDirectory(tomb, directory.revision, {
      action: "create",
      kind: "person",
      name: GUEST_PERSON_NAME,
      id: GUEST_PERSON_ID,
    });
    directory = await changeLocalDirectory(tomb, directory.revision, {
      action: "membership",
      organizationId: guestOrg.id,
      principalId: GUEST_PERSON_ID,
      role: "owner",
    });
    directory = await changeLocalDirectory(tomb, directory.revision, {
      action: "create",
      kind: "person",
      name: "Claimed owner",
    });
    const claimed = directory.entries.find(
      (entry) => entry.name === "Claimed owner",
    );
    directory = await changeLocalDirectory(tomb, directory.revision, {
      action: "create",
      kind: "organization",
      name: "Work org",
    });
    const workOrg = directory.entries.find(
      (entry) => entry.name === "Work org",
    );
    expect(claimed && workOrg).toBeTruthy();
    if (!claimed || !workOrg)
      throw new Error("claimed owner or work org missing");
    directory = await changeLocalDirectory(tomb, directory.revision, {
      action: "membership",
      organizationId: workOrg.id,
      principalId: claimed.id,
      role: "owner",
    });
    expect(
      directory.memberships.find(
        (row) =>
          row.organizationId === guestOrg.id &&
          row.principalId === GUEST_PERSON_ID,
      )?.role,
    ).toBe("member");
    expect(
      directory.memberships.find(
        (row) =>
          row.organizationId === guestOrg.id && row.principalId === claimed.id,
      )?.role,
    ).toBe("owner");
    expect(
      directory.memberships.find(
        (row) =>
          row.organizationId === workOrg.id && row.principalId === claimed.id,
      )?.role,
    ).toBe("owner");
  });
});
