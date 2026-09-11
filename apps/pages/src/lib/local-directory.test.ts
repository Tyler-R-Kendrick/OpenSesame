import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kvGet } from "./kv.js";
import {
  GUEST_PERSON_NAME,
  LOCAL_DIRECTORY_PATH,
  type LocalDirectory,
  PAGES_APPLICATION_ID,
  PAGES_APPLICATION_NAME,
  SUPPORT_AGENT_ID,
  SUPPORT_AGENT_NAME,
  changeLocalDirectory,
  ensureOwnerPerson,
  ownerPersonName,
  readLocalDirectory,
} from "./local-directory.js";
import { mintVaultKey } from "./vault/crypto.js";
import {
  lockAllTombs,
  readFile,
  tombFileKey,
  unlockTomb,
  writeFile,
} from "./vfs.js";

let tomb: string;
beforeEach(async () => {
  tomb = `directory-${crypto.randomUUID()}`;
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

describe("local encrypted directory", () => {
  it("reads legacy directories without rewriting them and upgrades on the next edit", async () => {
    const legacy = {
      version: 1,
      revision: 7,
      entries: [
        {
          id: `local_${crypto.randomUUID()}`,
          kind: "person",
          name: "Existing person",
          enabled: true,
        },
      ],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(legacy));
    await writeFile(tomb, LOCAL_DIRECTORY_PATH, bytes);
    expect(await readLocalDirectory(tomb)).toEqual({
      ...legacy,
      version: 2,
      memberships: [],
    });
    expect(await readFile(tomb, LOCAL_DIRECTORY_PATH)).toEqual(bytes);
    const next = await changeLocalDirectory(tomb, 7, {
      action: "create",
      kind: "organization",
      name: "New organization",
    });
    expect(next.version).toBe(2);
    expect(next.revision).toBe(8);
    expect(next.entries[0]).toEqual(legacy.entries[0]);
    expect(await readLocalDirectory(tomb)).toEqual(next);
  });

  it("refuses malformed version-two memberships rather than dropping their authority data", async () => {
    const value = {
      version: 2,
      revision: 1,
      entries: [],
      memberships: [
        { organizationId: "missing", principalId: "missing", role: "owner" },
      ],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    await writeFile(tomb, LOCAL_DIRECTORY_PATH, bytes);
    await expect(readLocalDirectory(tomb)).rejects.toThrow(
      "Invalid organization membership",
    );
    await expect(
      changeLocalDirectory(tomb, 1, {
        action: "create",
        kind: "person",
        name: "New",
      }),
    ).rejects.toThrow();
    expect(await readFile(tomb, LOCAL_DIRECTORY_PATH)).toEqual(bytes);
  });

  it.each(["person", "agent", "application", "organization"] as const)(
    "persists, edits, disables and deletes a %s without remote services",
    async (kind) => {
      const created = await changeLocalDirectory(tomb, 0, {
        action: "create",
        kind,
        name: "Sentinel name",
      });
      const entry = created.entries[0];
      expect(entry).toBeDefined();
      if (!entry) throw new Error("Missing created entry");
      expect(kvGet(tombFileKey(tomb, LOCAL_DIRECTORY_PATH))).not.toContain(
        "Sentinel name",
      );
      expect(await readLocalDirectory(tomb)).toEqual(created);
      const updated = await changeLocalDirectory(tomb, 1, {
        action: "update",
        id: entry.id,
        name: "Renamed",
        enabled: false,
      });
      expect(updated.entries[0]).toMatchObject({
        name: "Renamed",
        enabled: false,
      });
      expect(
        await changeLocalDirectory(tomb, 2, { action: "delete", id: entry.id }),
      ).toMatchObject({ revision: 3, entries: [] });
    },
  );

  it("rejects stale concurrent edits instead of losing the first change", async () => {
    const results = await Promise.allSettled([
      changeLocalDirectory(tomb, 0, {
        action: "create",
        kind: "person",
        name: "First",
      }),
      changeLocalDirectory(tomb, 0, {
        action: "create",
        kind: "agent",
        name: "Second",
      }),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect((await readLocalDirectory(tomb)).entries).toHaveLength(1);
  });

  it("keeps vault directories isolated and refuses access after locking", async () => {
    await changeLocalDirectory(tomb, 0, {
      action: "create",
      kind: "person",
      name: "Private",
    });
    const { vaultKey } = await mintVaultKey();
    unlockTomb("directory-other", vaultKey);
    expect((await readLocalDirectory("directory-other")).entries).toEqual([]);
    lockAllTombs();
    await expect(readLocalDirectory(tomb)).rejects.toMatchObject({
      code: "locked",
    });
    await expect(
      changeLocalDirectory(tomb, 1, { action: "delete", id: "missing" }),
    ).rejects.toMatchObject({ code: "locked" });
  });

  it.each(["", " ", "x".repeat(129), "line\nbreak", "a\u202eb"])(
    "rejects invalid names",
    async (name) => {
      await expect(
        changeLocalDirectory(tomb, 0, {
          action: "create",
          kind: "person",
          name,
        }),
      ).rejects.toThrow();
      expect((await readLocalDirectory(tomb)).entries).toEqual([]);
    },
  );

  it("registers an owner person and default organization when the directory has none", async () => {
    const first = await ensureOwnerPerson(tomb, "Ada Lovelace");
    expect(first.entries).toEqual([
      expect.objectContaining({ kind: "person", name: "Ada Lovelace" }),
      expect.objectContaining({ kind: "organization", name: "Ada Lovelace" }),
      expect.objectContaining({
        kind: "agent",
        name: SUPPORT_AGENT_NAME,
        id: "local_00000000-0000-4000-8000-000000000001",
      }),
      expect.objectContaining({
        kind: "application",
        name: PAGES_APPLICATION_NAME,
        id: PAGES_APPLICATION_ID,
      }),
    ]);
    const person = first.entries.find((entry) => entry.kind === "person");
    const org = first.entries.find((entry) => entry.kind === "organization");
    expect(first.memberships).toEqual([
      {
        organizationId: org?.id,
        principalId: person?.id,
        role: "owner",
      },
      {
        organizationId: org?.id,
        principalId: "local_00000000-0000-4000-8000-000000000001",
        role: "member",
      },
    ]);
    const second = await ensureOwnerPerson(tomb, "Someone else");
    expect(second.entries).toEqual(first.entries);
    expect(second.memberships).toEqual(first.memberships);
  });

  it("names the default organization Personal for a local-only owner", async () => {
    const directory = await ensureOwnerPerson(tomb, "Owner");
    expect(directory.entries).toEqual([
      expect.objectContaining({ kind: "person", name: "Owner" }),
      expect.objectContaining({ kind: "organization", name: "Personal" }),
      expect.objectContaining({ kind: "agent", name: SUPPORT_AGENT_NAME }),
      expect.objectContaining({
        kind: "application",
        name: PAGES_APPLICATION_NAME,
      }),
    ]);
  });

  it("names a guest person the same identity the prompt shows", async () => {
    expect(ownerPersonName(true)).toBe(GUEST_PERSON_NAME);
    expect(ownerPersonName(false, "guest", true)).toBe(GUEST_PERSON_NAME);
    expect(ownerPersonName(false, "Ada")).toBe("Ada");
    expect(ownerPersonName(false, null)).toBe("Owner");
    const directory = await ensureOwnerPerson(tomb, GUEST_PERSON_NAME);
    expect(directory.entries).toEqual([
      expect.objectContaining({ kind: "person", name: GUEST_PERSON_NAME }),
      expect.objectContaining({ kind: "organization", name: "Personal" }),
      expect.objectContaining({ kind: "agent", name: SUPPORT_AGENT_NAME }),
      expect.objectContaining({
        kind: "application",
        name: PAGES_APPLICATION_NAME,
      }),
    ]);
  });

  it("renames a placeholder Owner person to the guest identity", async () => {
    await ensureOwnerPerson(tomb, "Owner");
    const directory = await ensureOwnerPerson(tomb, GUEST_PERSON_NAME);
    expect(
      directory.entries.find((entry) => entry.kind === "person")?.name,
    ).toBe(GUEST_PERSON_NAME);
    expect(
      directory.entries.find((entry) => entry.kind === "organization")?.name,
    ).toBe("Personal");
  });

  it("renames the placeholder Support agent to open-sesame", async () => {
    await changeLocalDirectory(tomb, 0, {
      action: "create",
      kind: "agent",
      name: "Support",
      id: SUPPORT_AGENT_ID,
    });
    const directory = await ensureOwnerPerson(tomb, "Ada");
    expect(
      directory.entries.find((entry) => entry.id === SUPPORT_AGENT_ID)?.name,
    ).toBe(SUPPORT_AGENT_NAME);
  });

  it("treats ciphertext from a destroyed guest key as an empty directory", async () => {
    await changeLocalDirectory(tomb, 0, {
      action: "create",
      kind: "person",
      name: "Ada",
    });
    const leftover = kvGet(tombFileKey(tomb, LOCAL_DIRECTORY_PATH));
    expect(leftover).toBeTruthy();
    lockAllTombs();
    const { vaultKey } = await mintVaultKey();
    unlockTomb(tomb, vaultKey);
    expect(await readLocalDirectory(tomb)).toEqual({
      version: 2,
      revision: 0,
      entries: [],
      memberships: [],
    });
  });

  it("never replaces a corrupt directory with an empty one", async () => {
    await writeFile(
      tomb,
      LOCAL_DIRECTORY_PATH,
      new TextEncoder().encode('{"version":2}'),
    );
    await expect(
      changeLocalDirectory(tomb, 0, {
        action: "create",
        kind: "person",
        name: "New",
      }),
    ).rejects.toThrow();
    expect(
      new TextDecoder().decode(await readFile(tomb, LOCAL_DIRECTORY_PATH)),
    ).toBe('{"version":2}');
  });

  it("refuses unsafe editing when browser locks are unavailable", async () => {
    vi.stubGlobal("navigator", {});
    await expect(
      changeLocalDirectory(tomb, 0, {
        action: "create",
        kind: "person",
        name: "New",
      }),
    ).rejects.toThrow("Web Locks");
  });
});
