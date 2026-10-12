import { createVault } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setGuestsAllowed } from "./guest-access.js";
import { guestAuthSeams } from "./guest-auth.js";
import { kvDelete, kvSet } from "./kv.js";
import {
  clearGuestSessionPerson,
  mintGuestSessionPerson,
} from "./local-guest.js";
import {
  PERSONAL_PROJECT_ID,
  type ProjectsState,
  projectSeams,
} from "./projects.js";
import { GUEST_TOMB, vaultStore } from "./vault/store.js";
import {
  describeSealedAt,
  enterActiveProjectScope,
  listDeviceVaults,
  openVaultLabel,
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
  clearGuestSessionPerson();
});

afterEach(() => {
  Object.assign(projectSeams, originalProjectSeams);
  Object.assign(guestAuthSeams, originalGuestSeams);
  vaultStore.lock();
  clearGuestSessionPerson();
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

  it("uses the guest-N slug once a guest session exists", () => {
    mintGuestSessionPerson();
    expect(vaultLabel({ id: GUEST_TOMB, name: GUEST_TOMB })).toBe("guest-1");
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
    expect(work?.address).toBeNull();
    expect(guest?.kind).toBe("guest");
    expect(guest?.state).toBe("empty");
    expect(guest?.address).toBeNull();
  });

  it("shows owner/slug from the tomb header and keeps a sealed name", async () => {
    const { header } = await createVault(PASSWORD);
    kvSet(
      tombFileKey("prj_named", HEADER_PATH),
      JSON.stringify({
        ...header,
        publishedAddress: {
          ownerKind: "organization",
          owner: "acme",
          slug: "ledger",
        },
      }),
    );
    kvSet(
      tombFileKey(PERSONAL_TOMB, HEADER_PATH),
      JSON.stringify({
        ...header,
        publishedAddress: { ownerKind: "user", owner: "ada", slug: "personal" },
      }),
    );
    const vaults = listDeviceVaults();
    const personal = vaults.find((vault) => vault.id === PERSONAL_PROJECT_ID);
    const work = vaults.find((vault) => vault.id === "prj_named");
    const unnamed = vaults.find((vault) => vault.id.endsWith("f4a2"));
    expect(personal?.label).toBe("personal");
    expect(personal?.address).toEqual({
      ownerKind: "user",
      owner: "ada",
      slug: "personal",
    });
    expect(work?.label).toBe("Work");
    expect(work?.address).toEqual({
      ownerKind: "organization",
      owner: "acme",
      slug: "ledger",
    });
    expect(unnamed?.address).toBeNull();
    expect(unnamed?.label).toBe("project · f4a2");
    expect(JSON.stringify(work)).not.toContain(PASSWORD);
  });

  it("ignores a published address that does not parse", async () => {
    const { header } = await createVault(PASSWORD);
    kvSet(
      tombFileKey("prj_named", HEADER_PATH),
      JSON.stringify({
        ...header,
        publishedAddress: {
          ownerKind: "user",
          owner: "Guest",
          slug: "personal",
        },
      }),
    );
    const work = listDeviceVaults().find((vault) => vault.id === "prj_named");
    expect(work?.address).toBeNull();
    expect(work?.label).toBe("Work");
  });

  it("never lists the guest tomb twice when guest files exist on disk", async () => {
    await vaultStore.createGuest();
    vaultStore.lock();
    const vaults = listDeviceVaults();
    const guests = vaults.filter((vault) => vault.id === GUEST_TOMB);
    expect(guests).toHaveLength(1);
    expect(guests[0]?.kind).toBe("guest");
  });

  it("offers no guest row while the operator has guests switched off", async () => {
    await setGuestsAllowed(false);
    try {
      expect(listDeviceVaults().some((vault) => vault.id === GUEST_TOMB)).toBe(
        false,
      );
    } finally {
      await setGuestsAllowed(true);
    }
    expect(listDeviceVaults().at(-1)?.id).toBe(GUEST_TOMB);
  });

  it("marks the guest row open while a guest session runs — never the tomb it borrows", async () => {
    await vaultStore.createGuest();
    const vaults = listDeviceVaults();
    const guest = vaults.at(-1);
    expect(guest?.id).toBe(GUEST_TOMB);
    expect(guest?.state).toBe("open");
    // Guests always unlock GUEST_TOMB — personal stays closed beside them.
    expect(vaults[0]?.state).not.toBe("open");
  });
});

describe("a duress decoy in the list", () => {
  it("is the open vault the unlock screen showed, never the guest row", async () => {
    await vaultStore.createGuest({ decoy: true });
    const snapshot = vaultStore.getSnapshot();
    expect(snapshot.guest).toBe(true);
    expect(snapshot.decoy).toBe(true);
    const vaults = listDeviceVaults();
    expect(vaults[0]?.id).toBe(PERSONAL_PROJECT_ID);
    expect(vaults[0]?.state).toBe("open");
    expect(vaults.at(-1)?.id).toBe(GUEST_TOMB);
    expect(vaults.at(-1)?.state).not.toBe("open");
    expect(openVaultLabel()).toBe("personal");
    vaultStore.lock();
  });

  it("leaves an ordinary guest as the guest row", async () => {
    await vaultStore.createGuest();
    expect(vaultStore.getSnapshot().decoy).toBe(false);
    expect(openVaultLabel()).toBe("guest");
    vaultStore.lock();
  });
});

describe("switchVault", () => {
  it("the guest road locks the open vault and lands on guest Unlock", async () => {
    await vaultStore.createWithPin("24681357");
    expect(vaultStore.isUnlocked()).toBe(true);
    await expect(switchVault(GUEST_TOMB)).resolves.toBe("locked");
    const snap = vaultStore.getSnapshot();
    expect(snap.tomb).toBe(GUEST_TOMB);
    expect(snap.status).toBe("empty");
    expect(vaultStore.isUnlocked()).toBe(false);
  });

  it("refuses a vault that is not on this device", async () => {
    await expect(switchVault("prj_ghost")).rejects.toThrow(/no longer exists/);
  });

  it("runs a second switch only after the first settles", async () => {
    let activeId = PERSONAL_PROJECT_ID;
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let held = true;
    Object.assign(projectSeams, {
      activeProject: () =>
        state.projects.find((project) => project.id === activeId) ??
        state.projects[0],
      setActiveProject: async (id: string) => {
        order.push(`begin:${id}`);
        if (held) {
          held = false;
          await firstGate;
        }
        activeId = id;
        order.push(`end:${id}`);
      },
    });
    const first = switchVault("prj_named");
    await vi.waitFor(() => expect(order).toEqual(["begin:prj_named"]));
    const second = switchVault(PERSONAL_PROJECT_ID);
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["begin:prj_named"]);
    releaseFirst();
    await expect(first).resolves.toBe("locked");
    await expect(second).resolves.toBe("locked");
    expect(order).toEqual([
      "begin:prj_named",
      "end:prj_named",
      "begin:personal",
      "end:personal",
    ]);
  });

  it("enterActiveProjectScope throws when the active vault moved mid-flight", async () => {
    let activeId = PERSONAL_PROJECT_ID;
    Object.assign(projectSeams, {
      activeProject: () =>
        state.projects.find((project) => project.id === activeId) ??
        state.projects[0],
    });
    const pending = enterActiveProjectScope(false);
    activeId = "prj_named";
    await expect(pending).rejects.toThrow(/changed while switching/);
  });
});

describe("removeVault", () => {
  it("never deletes the vault that is open", async () => {
    await vaultStore.createGuest();
    await expect(removeVault(GUEST_TOMB)).rejects.toThrow(/Lock this vault/);
  });
});
