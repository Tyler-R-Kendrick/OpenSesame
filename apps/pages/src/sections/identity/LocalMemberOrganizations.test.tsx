import { webLocksDouble } from "@opensesame/app-core/lib/__tests__/web-locks-double.js";
import { beginLocalAgentAuthentication } from "@opensesame/app-core/lib/local-agent-auth.js";
import {
  readLocalAgentKeys,
  registerLocalAgentKey,
} from "@opensesame/app-core/lib/local-agent-keys.js";
import {
  authenticator,
  origin,
  rpID,
} from "@opensesame/app-core/lib/local-authenticator.fixture.js";
import { changeLocalDirectory } from "@opensesame/app-core/lib/local-directory-admin.js";
import {
  type LocalDirectoryChange,
  readLocalDirectory,
} from "@opensesame/app-core/lib/local-directory.js";
import { enrollLocalPasskey } from "@opensesame/app-core/lib/local-passkeys.js";
import {
  currentLocalIdentitySession,
  signInLocalAgent,
  signInLocalIdentity,
} from "@opensesame/app-core/lib/local-sessions.js";
import { lockAllTombs, unlockTomb } from "@opensesame/app-core/lib/vfs.js";
/** @vitest-environment jsdom */
import { createLocalAgentKey } from "@opensesame/static-auth";
import { mintVaultKey } from "@opensesame/vault-core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalIdentitySession } from "./LocalIdentitySession.js";
import { LocalMemberOrganizations } from "./LocalMemberOrganizations.js";

type Device = Awaited<ReturnType<typeof authenticator>>;
let tomb: string;
let device: Device;
const devices = new Map<string, Device>();
const ids: Record<string, string> = {};

async function change(command: LocalDirectoryChange) {
  const current = await readLocalDirectory(tomb);
  return changeLocalDirectory(tomb, current.revision, command);
}
async function create(kind: "person" | "agent" | "organization", name: string) {
  const result = await change({ action: "create", kind, name });
  const record = result.entries.find((row) => row.name === name);
  if (!record) throw new Error(`Missing ${name}`);
  ids[name] = record.id;
  return record.id;
}
function id(name: string) {
  const value = ids[name];
  if (!value) throw new Error(`Unknown ${name}`);
  return value;
}
/** A real enrolled passkey and a real WebAuthn sign-in, per person. */
async function signIn(name: string) {
  const saved = devices.get(name);
  device = saved ?? (await authenticator());
  if (!saved) {
    await enrollLocalPasskey(tomb, id(name));
    devices.set(name, device);
  }
  return signInLocalIdentity(tomb, id(name));
}
async function memberships() {
  return (await readLocalDirectory(tomb)).memberships
    .filter((row) => row.organizationId === id("First organization"))
    .map((row) => [row.principalId, row.role]);
}

beforeEach(async () => {
  // jsdom's realm differs from Node's TextEncoder/WebCrypto realm.
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  tomb = `member-orgs-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("location", { origin, hostname: rpID });
  vi.stubGlobal("navigator", {
    credentials: {
      create: (options: CredentialCreationOptions) => device.create(options),
      get: (options: CredentialRequestOptions) => device.get(options),
    },
    locks: webLocksDouble(),
  });
  for (const name of ["Owner", "Admin", "Member", "Outsider"])
    await create("person", name);
  await create("agent", "Build agent");
  const org = await create("organization", "First organization");
  const other = await create("organization", "Other organization");
  for (const [name, role] of [
    ["Owner", "owner"],
    ["Admin", "admin"],
    ["Member", "member"],
    ["Build agent", "member"],
  ] as const)
    await change({
      action: "membership",
      organizationId: org,
      principalId: id(name),
      role,
    });
  await change({
    action: "membership",
    organizationId: other,
    principalId: id("Outsider"),
    role: "owner",
  });
});
afterEach(() => {
  cleanup();
  lockAllTombs();
  devices.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Sign in, draw the session, and open its first organization. */
async function openAs(name: string) {
  await signIn(name);
  render(
    <LocalIdentitySession
      tomb={tomb}
      principalId={id(name)}
      disabled={false}
    />,
  );
  const section = await screen.findByRole("region", { name: "Organizations" });
  await within(section).findByRole("img", {
    name: "Member of 1 organization.",
  });
  expect(within(section).queryByText("Other organization")).toBeNull();
  await userEvent.click(within(section).getByText("First organization"));
  await within(section).findByRole("img", { name: "4 members." });
  return section;
}
/** A member's row, found by its name (a role chip may read the same word). */
function row(section: HTMLElement, name: string) {
  const item = [...section.querySelectorAll("details li")].find(
    (li) =>
      li.querySelector(".identity-row__id > span:first-child")?.textContent ===
      name,
  );
  if (!(item instanceof HTMLElement)) throw new Error(`Missing row ${name}`);
  return item;
}

describe("the signed-in member's organizations", () => {
  it("lets an owner change a role, then ends every local session", async () => {
    const section = await openAs("Owner");
    const select = within(row(section, "Member")).getByRole("combobox", {
      name: "Role for Member",
    });
    const save = within(row(section, "Member")).getByRole("button", {
      name: "Save role",
    });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.change(select, { target: { value: "admin" } });
    await userEvent.click(save);
    await screen.findByRole("img", {
      name: "Membership changed. Local sessions ended; sign in again.",
    });
    expect(await memberships()).toContainEqual([id("Member"), "admin"]);
    // ADR 0104's revision binding, observed rather than assumed.
    expect(await currentLocalIdentitySession(tomb, id("Owner"))).toBeNull();
    expect(screen.queryByRole("region", { name: "Organizations" })).toBeNull();
    const signInKey = screen.getByRole("button", { name: "Sign in locally" });
    expect(signInKey).toHaveProperty("disabled", false);
    expect(document.activeElement).toBe(signInKey);
    await userEvent.click(signInKey);
    await screen.findByRole("region", { name: "Organizations" });
    expect(
      screen.getByRole("status", { name: "Local session status" }).textContent,
    ).toBe(
      "Signed in locally with a passkey. No application access was granted.",
    );
  });

  it("never offers an agent member a privileged role", async () => {
    const section = await openAs("Owner");
    const agent = row(section, "Build agent");
    expect(within(agent).queryByRole("combobox")).toBeNull();
    within(agent).getByRole("button", { name: "Remove member" });
  });

  it("shows the directory's last-owner refusal as a mark and keeps the session", async () => {
    const section = await openAs("Owner");
    const before = await memberships();
    const remove = within(row(section, "Owner")).getByRole("button", {
      name: "Remove member",
    });
    await userEvent.click(remove);
    await userEvent.click(
      within(row(section, "Owner")).getByRole("button", {
        name: "Confirm removal",
      }),
    );
    const mark = await within(section).findByRole("img", {
      name: "Keep an enabled person as organization owner before removing or disabling the last owner.",
    });
    expect(mark.className).toContain("status-mark--err");
    expect(document.querySelector(".note")).toBeNull();
    expect(await memberships()).toEqual(before);
    expect(await currentLocalIdentitySession(tomb, id("Owner"))).not.toBeNull();
  });

  it("lets an admin remove an ordinary member, confirmed, and nothing else", async () => {
    const section = await openAs("Admin");
    for (const name of ["Owner", "Admin"])
      expect(within(row(section, name)).queryAllByRole("button")).toEqual([]);
    expect(within(section).queryAllByRole("combobox")).toEqual([]);
    const remove = within(row(section, "Member")).getByRole("button", {
      name: "Remove member",
    });
    await userEvent.click(remove);
    await userEvent.click(
      within(row(section, "Member")).getByRole("button", {
        name: "Keep member",
      }),
    );
    expect(document.activeElement).toBe(remove);
    expect(remove.getAttribute("aria-label")).toBe("Remove member");
    await userEvent.click(remove);
    await userEvent.click(
      within(row(section, "Member")).getByRole("button", {
        name: "Confirm removal",
      }),
    );
    await screen.findByRole("img", {
      name: "Membership changed. Local sessions ended; sign in again.",
    });
    expect(await memberships()).not.toContainEqual([id("Member"), "member"]);
    expect(await currentLocalIdentitySession(tomb, id("Admin"))).toBeNull();
  });

  it("keeps an ordinary member read-only", async () => {
    const section = await openAs("Member");
    const open = section.querySelector("details[open]");
    if (!(open instanceof HTMLElement)) throw new Error("Missing open org");
    expect(within(open).queryAllByRole("button")).toEqual([]);
    expect(within(open).queryAllByRole("combobox")).toEqual([]);
    for (const name of ["Owner", "Admin", "Member", "Build agent"])
      row(section, name);
  });

  it("shows an agent-key session its organizations read-only", async () => {
    const agent = id("Build agent");
    const key = await createLocalAgentKey();
    await registerLocalAgentKey(tomb, agent, key.publicKey);
    const enrolled = (await readLocalAgentKeys(tomb))[0];
    if (!enrolled) throw new Error("Missing agent key");
    const challenge = await beginLocalAgentAuthentication(
      tomb,
      agent,
      enrolled.credentialId,
    );
    const session = await signInLocalAgent(
      tomb,
      challenge.nonce,
      await key.signChallenge(challenge, origin, agent),
    );
    render(<LocalMemberOrganizations tomb={tomb} session={session} />);
    const section = await screen.findByRole("region", {
      name: "Organizations",
    });
    await userEvent.click(
      await within(section).findByText("First organization"),
    );
    await within(section).findByRole("img", { name: "4 members." });
    expect(within(section).queryAllByRole("button")).toEqual([]);
    expect(within(section).queryAllByRole("combobox")).toEqual([]);
  });

  it("lists nothing for a person in no organization it can see", async () => {
    await create("person", "Loner");
    await signIn("Loner");
    render(
      <LocalIdentitySession
        tomb={tomb}
        principalId={id("Loner")}
        disabled={false}
      />,
    );
    const section = await screen.findByRole("region", {
      name: "Organizations",
    });
    await within(section).findByRole("img", {
      name: "Not a member of any organization.",
    });
    expect(within(section).queryByRole("list")).toBeNull();
  });

  it("draws nothing without a session", async () => {
    render(
      <LocalIdentitySession
        tomb={tomb}
        principalId={id("Owner")}
        disabled={false}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Local session status" })
          .textContent,
      ).toBe("No active local session."),
    );
    expect(screen.queryByRole("region", { name: "Organizations" })).toBeNull();
  });
});
