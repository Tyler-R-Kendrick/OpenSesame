import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerLocalAgentKey } from "./local-agent-keys.js";
import { configureLocalApplication } from "./local-applications.js";
import { authenticator } from "./local-authenticator.fixture.js";
import { revokeRecordedLocalGrant } from "./local-grant-admin.js";
import { enrollLocalPasskey } from "./local-passkeys.js";
import { resolveCurrentAccessRole } from "./local-rbac.js";
import { localRequestFixture } from "./local-request.fixture.js";
import {
  revokeLocalIdentitySession,
  signInLocalIdentity,
} from "./local-sessions.js";
import { listVaultSessions } from "./local-vault-sessions.js";
import { lockAllTombs } from "./vfs.js";

const OPERATOR_ONLY = /Only an operator/;

afterEach(() => {
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// A signed-in local person is the actor (`resolveCurrentAccessRole`): an
// organization member holds none of the Access capabilities.
describe("local Access capabilities for a signed-in member", () => {
  it("refuses a signed-in member, after the operator's own changes succeed", async () => {
    const fixture = await localRequestFixture();
    const withBob = await fixture.change({
      action: "create",
      kind: "person",
      name: "Bob",
    });
    const bob = withBob.entries.find((row) => row.name === "Bob");
    // A directory edit invalidates the session that made it; the owner signs
    // in again before the next administrative change.
    await signInLocalIdentity(fixture.tomb, fixture.personId);
    const withAgent = await fixture.change({
      action: "create",
      kind: "agent",
      name: "Build bot",
    });
    const agent = withAgent.entries.find((row) => row.name === "Build bot");
    await signInLocalIdentity(fixture.tomb, fixture.personId);
    await fixture.change({
      action: "membership",
      organizationId: fixture.organizationId,
      principalId: bob?.id ?? "",
      role: "member",
    });
    // Bob's own authenticator, beside the same lock queue.
    vi.stubGlobal("navigator", {
      ...navigator,
      credentials: await authenticator(),
    });
    await enrollLocalPasskey(fixture.tomb, bob?.id ?? "");
    const session = await signInLocalIdentity(fixture.tomb, bob?.id ?? "");
    expect(await resolveCurrentAccessRole(fixture.tomb)).toBe("member");
    await expect(
      fixture.change({
        action: "membership",
        organizationId: fixture.organizationId,
        principalId: bob?.id ?? "",
        role: "admin",
      }),
    ).rejects.toThrow(OPERATOR_ONLY);
    await expect(
      fixture.change({
        action: "update",
        id: fixture.personId,
        name: "guest-3",
        enabled: true,
      }),
    ).rejects.toThrow(OPERATOR_ONLY);
    await expect(
      configureLocalApplication(fixture.tomb, 1, fixture.applicationId, null),
    ).rejects.toThrow(OPERATOR_ONLY);
    await expect(
      revokeRecordedLocalGrant(fixture.tomb, "grant-1"),
    ).rejects.toThrow(OPERATOR_ONLY);
    await expect(listVaultSessions(fixture.tomb)).rejects.toThrow(
      OPERATOR_ONLY,
    );
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    await expect(
      registerLocalAgentKey(
        fixture.tomb,
        agent?.id ?? "",
        overlapCast(publicJwk),
      ),
    ).rejects.toThrow(OPERATOR_ONLY);
    await revokeLocalIdentitySession(fixture.tomb, session.id);
    // A member's own sign-out is not a road back to the custodian role.
    expect(await resolveCurrentAccessRole(fixture.tomb)).toBe("guest");
  });

  it("does not promote an expired member session to the vault custodian", async () => {
    const fixture = await localRequestFixture();
    const withBob = await fixture.change({
      action: "create",
      kind: "person",
      name: "Bob",
    });
    const bob = withBob.entries.find((row) => row.name === "Bob");
    await signInLocalIdentity(fixture.tomb, fixture.personId);
    await fixture.change({
      action: "membership",
      organizationId: fixture.organizationId,
      principalId: bob?.id ?? "",
      role: "member",
    });
    vi.stubGlobal("navigator", {
      ...navigator,
      credentials: await authenticator(),
    });
    await enrollLocalPasskey(fixture.tomb, bob?.id ?? "");
    await signInLocalIdentity(fixture.tomb, bob?.id ?? "");
    expect(await resolveCurrentAccessRole(fixture.tomb)).toBe("member");

    // Past the session lifetime the tab still remembers that it signed in.
    // That memory forbids the custodian fallback even though no live session
    // can be read any more.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 16 * 60_000);
    expect(await resolveCurrentAccessRole(fixture.tomb)).toBe("guest");
    await expect(
      fixture.change({
        action: "update",
        id: fixture.personId,
        name: "guest-3",
        enabled: true,
      }),
    ).rejects.toThrow(OPERATOR_ONLY);
  });
});
