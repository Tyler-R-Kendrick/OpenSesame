import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guestAuthSeams } from "./guest-auth.js";
import { kvDelete, kvSet } from "./kv.js";
import {
  PERSONAL_PROJECT_ID,
  type ProjectsState,
  projectSeams,
} from "./projects.js";
import { createVault } from "./vault/crypto.js";
import { GUEST_TOMB, vaultStore } from "./vault/store.js";
import {
  describeSealedAt,
  listDeviceVaults,
  removeVault,
  switchVault,
  vaultLabel,
} from "./vaults.js";
import { HEADER_PATH, PERSONAL_TOMB, tombFileKey } from "./vfs.js";

const PASSWORD = "correct horse battery staple";

const state: ProjectsState = {
  v: 1,
  projects: [
    {
      id: PERSONAL_PROJECT_ID,
      name: "Personal",
      kind: "personal",
      createdAt: "2025-01-01T00:00:00Z",
    },
    // Pre-unlock: the boot view names a project by its id.
    {
      id: "prj_1234abcd-0000-0000-0000-00000000f4a2",
      name: "prj_1234abcd-0000-0000-0000-00000000f4a2",
      kind: "standard",
      createdAt: "2025-01-02T00:00:00Z",
    },
    {
      id: "prj_named",
      name: "Work",
      kind: "standard",
      createdAt: "2025-01-03T00:00:00Z",
    },
  ],
  activeId: PERSONAL_PROJECT_ID,
};

const originalProjectSeams = { ...projectSeams };
const originalGuestSeams = { ...guestAuthSeams };

beforeEach(() => {
  Object.assign(projectSeams, {
    projectsState: () => state,
    subscribeProjects: () => () => {},
    activeProject: () => state.projects[0],
  });
  kvDelete(tombFileKey(PERSONAL_TOMB, HEADER_PATH));
  kvDelete(tombFileKey("prj_named", HEADER_PATH));
});

afterEach(() => {
  Object.assign(projectSeams, originalProjectSeams);
  Object.assign(guestAuthSeams, originalGuestSeams);
  vaultStore.lock();
});

describe("vaultLabel — honest before unlock", () => {
  it("never shows a sealed name it does not have", () => {
    expect(vaultLabel({ id: PERSONAL_PROJECT_ID, name: "Personal" })).toBe(
      "personal",
    );
    expect(
      vaultLabel({
        id: "prj_1234abcd-0000-0000-0000-00000000f4a2",
        name: "prj_1234abcd-0000-0000-0000-00000000f4a2",
      }),
    ).toBe("project · f4a2");
    expect(vaultLabel({ id: "prj_named", name: "Work" })).toBe("Work");
    expect(vaultLabel({ id: GUEST_TOMB, name: GUEST_TOMB })).toBe("guest");
  });
});

describe("describeSealedAt", () => {
  it("says when, or nothing", () => {
    expect(describeSealedAt(null)).toBeNull();
    expect(describeSealedAt("not a date")).toBeNull();
    const text = describeSealedAt("2026-08-14T10:00:00Z");
    expect(text).toMatch(/^sealed /);
    expect(text).toContain("2026");
  });
});

describe("listDeviceVaults", () => {
  it("lists every project, its sealed state, and the guest road last", async () => {
    const { header } = await createVault(PASSWORD);
    kvSet(tombFileKey("prj_named", HEADER_PATH), JSON.stringify(header));

    const vaults = listDeviceVaults();
    expect(vaults.map((vault) => vault.id)).toEqual([
      PERSONAL_PROJECT_ID,
      "prj_1234abcd-0000-0000-0000-00000000f4a2",
      "prj_named",
      GUEST_TOMB,
    ]);
    const [personal, unnamed, work, guest] = vaults;
    expect(personal?.state).toBe("empty");
    expect(unnamed?.named).toBe(false);
    expect(unnamed?.label).toBe("project · f4a2");
    expect(work?.state).toBe("locked");
    expect(work?.sealedAt).toBe(header.createdAt);
    expect(work?.sharedKey).toBe(false);
    expect(guest?.kind).toBe("guest");
    expect(guest?.state).toBe("empty");
  });

  it("marks the guest row open while a guest session runs — never the tomb it borrows", async () => {
    await vaultStore.createGuest();
    const vaults = listDeviceVaults();
    const guest = vaults.at(-1);
    expect(guest?.id).toBe(GUEST_TOMB);
    expect(guest?.state).toBe("open");
    // A first-run guest lives in the personal tomb; that row is not "open".
    expect(vaults[0]?.state).not.toBe("open");
  });
});

describe("switchVault", () => {
  it("the guest road locks nothing it does not own and continues as guest", async () => {
    const continueAsGuest = vi.fn().mockResolvedValue(undefined);
    Object.assign(guestAuthSeams, { continueAsGuest });
    await expect(switchVault(GUEST_TOMB)).resolves.toBe("opened");
    expect(continueAsGuest).toHaveBeenCalledTimes(1);
  });

  it("refuses a vault that is not on this device", async () => {
    await expect(switchVault("prj_ghost")).rejects.toThrow(/no longer exists/);
  });
});

describe("removeVault", () => {
  it("never deletes the vault that is open", async () => {
    await vaultStore.createGuest();
    await expect(removeVault(GUEST_TOMB)).rejects.toThrow(/Lock this vault/);
  });
});
