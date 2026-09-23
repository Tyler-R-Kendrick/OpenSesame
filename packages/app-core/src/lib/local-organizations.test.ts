import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticator, origin, rpID } from "./local-authenticator.fixture.js";
import {
  type LocalDirectoryChange,
  changeLocalDirectory,
  readLocalDirectory,
} from "./local-directory.js";
import {
  changeLocalOrganizationMembership,
  listLocalOrganizations,
  readLocalOrganization,
} from "./local-organizations.js";
import { enrollLocalPasskey } from "./local-passkeys.js";
import { signInLocalIdentity } from "./local-sessions.js";
import { mintVaultKey } from "./vault/crypto.js";
import { vaultStore } from "./vault/store.js";
import { lockAllTombs, unlockTomb } from "./vfs.js";

let tomb: string;
let org: string;
let otherOrg: string;
let owner: string;
let admin: string;
let member: string;
let outsider: string;
let agent: string;
let device: Awaited<ReturnType<typeof authenticator>>;
const devices = new Map<string, Awaited<ReturnType<typeof authenticator>>>();

async function change(command: LocalDirectoryChange) {
  const current = await readLocalDirectory(tomb);
  return changeLocalDirectory(tomb, current.revision, command);
}
async function create(kind: "person" | "agent" | "organization", name: string) {
  const result = await change({ action: "create", kind, name });
  const record = result.entries.find((row) => row.name === name);
  if (!record) throw new Error("Missing identity");
  return record.id;
}
async function signIn(principalId: string) {
  const saved = devices.get(principalId);
  device = saved ?? (await authenticator());
  if (!saved) {
    await enrollLocalPasskey(tomb, principalId);
    devices.set(principalId, device);
  }
  return signInLocalIdentity(tomb, principalId);
}

beforeEach(async () => {
  tomb = `org-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  let queue = Promise.resolve();
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("location", { origin, hostname: rpID });
  vi.stubGlobal("navigator", {
    credentials: {
      create: (options: CredentialCreationOptions) => device.create(options),
      get: (options: CredentialRequestOptions) => device.get(options),
    },
    locks: {
      request: <T>(_name: string, run: () => Promise<T>) => {
        const next = queue.then(run);
        queue = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    },
  });
  owner = await create("person", "Owner");
  admin = await create("person", "Admin");
  member = await create("person", "Member");
  outsider = await create("person", "Unrelated person");
  agent = await create("agent", "Agent");
  org = await create("organization", "First organization");
  otherOrg = await create("organization", "Other organization");
  await change({
    action: "membership",
    organizationId: org,
    principalId: owner,
    role: "owner",
  });
  await change({
    action: "membership",
    organizationId: org,
    principalId: admin,
    role: "admin",
  });
  await change({
    action: "membership",
    organizationId: org,
    principalId: member,
    role: "member",
  });
  await change({
    action: "membership",
    organizationId: otherOrg,
    principalId: outsider,
    role: "owner",
  });
});
afterEach(() => {
  vaultStore.lock();
  lockAllTombs();
  devices.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser-local organization authorization", () => {
  it.each(["owner", "admin", "member"])(
    "lets an authenticated %s read only their organization",
    async (role) => {
      const id = role === "owner" ? owner : role === "admin" ? admin : member;
      const session = await signIn(id);
      expect(await listLocalOrganizations(tomb, session)).toEqual([
        { id: org, name: "First organization", role },
      ]);
      const result = await readLocalOrganization(tomb, session, org);
      expect(result.members).toHaveLength(3);
      await expect(
        readLocalOrganization(tomb, session, otherOrg),
      ).rejects.toThrow("organization is unavailable");
      await expect(
        readLocalOrganization(tomb, session, "missing"),
      ).rejects.toThrow("organization is unavailable");
    },
  );

  it("lets owners assign roles and invalidates sessions on the committed policy change", async () => {
    const session = await signIn(owner);
    await changeLocalOrganizationMembership(
      tomb,
      session,
      org,
      outsider,
      "admin",
    );
    expect((await readLocalDirectory(tomb)).memberships).toContainEqual({
      organizationId: org,
      principalId: outsider,
      role: "admin",
    });
    await expect(readLocalOrganization(tomb, session, org)).rejects.toThrow(
      "session is unavailable",
    );
  });

  it("lets admins add ordinary members but not create privileged peers", async () => {
    const session = await signIn(admin);
    await expect(
      changeLocalOrganizationMembership(tomb, session, org, outsider, "owner"),
    ).rejects.toThrow("organization is unavailable");
    await expect(
      changeLocalOrganizationMembership(tomb, session, org, outsider, "admin"),
    ).rejects.toThrow("organization is unavailable");
    await expect(
      changeLocalOrganizationMembership(tomb, session, org, owner, null),
    ).rejects.toThrow("organization is unavailable");
    await changeLocalOrganizationMembership(
      tomb,
      session,
      org,
      outsider,
      "member",
    );
    expect((await readLocalDirectory(tomb)).memberships).toContainEqual({
      organizationId: org,
      principalId: outsider,
      role: "member",
    });
  });

  it("refuses ordinary-member mutation and cross-organization administration", async () => {
    const memberSession = await signIn(member);
    await expect(
      changeLocalOrganizationMembership(
        tomb,
        memberSession,
        org,
        outsider,
        "member",
      ),
    ).rejects.toThrow("organization is unavailable");
    const ownerSession = await signIn(owner);
    await expect(
      changeLocalOrganizationMembership(
        tomb,
        ownerSession,
        otherOrg,
        owner,
        "owner",
      ),
    ).rejects.toThrow("organization is unavailable");
  });

  it.each(["remove", "demote", "disable", "delete"])(
    "preserves the last enabled owner on %s",
    async (command) => {
      const before = await readLocalDirectory(tomb);
      const changeCommand: LocalDirectoryChange =
        command === "delete"
          ? { action: "delete", id: owner }
          : command === "disable"
            ? { action: "update", id: owner, name: "Owner", enabled: false }
            : {
                action: "membership",
                organizationId: org,
                principalId: owner,
                role: command === "remove" ? null : "member",
              };
      await expect(change(changeCommand)).rejects.toThrow("organization owner");
      expect(await readLocalDirectory(tomb)).toEqual(before);
    },
  );

  it("permits ownership transfer before the old owner is deleted", async () => {
    await change({
      action: "membership",
      organizationId: org,
      principalId: admin,
      role: "owner",
    });
    await change({ action: "delete", id: owner });
    expect(
      (await readLocalDirectory(tomb)).memberships.some(
        (row) => row.principalId === owner,
      ),
    ).toBe(false);
  });

  it("allows agent membership but never agent owner/admin authority", async () => {
    await expect(
      change({
        action: "membership",
        organizationId: org,
        principalId: agent,
        role: "owner",
      }),
    ).rejects.toThrow("Invalid organization membership");
    await expect(
      change({
        action: "membership",
        organizationId: org,
        principalId: agent,
        role: "admin",
      }),
    ).rejects.toThrow("Invalid organization membership");
    await change({
      action: "membership",
      organizationId: org,
      principalId: agent,
      role: "member",
    });
  });

  it("removes organization memberships with the organization in one record", async () => {
    await change({ action: "delete", id: org });
    const directory = await readLocalDirectory(tomb);
    expect(
      directory.memberships.some((row) => row.organizationId === org),
    ).toBe(false);
    expect(directory.memberships).toContainEqual({
      organizationId: otherOrg,
      principalId: outsider,
      role: "owner",
    });
  });
});
