import { afterEach, describe, expect, it, vi } from "vitest";
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
    await fixture.change({
      action: "membership",
      organizationId: fixture.organizationId,
      principalId: bob?.id ?? "",
      role: "member",
    });
    // The owner signing out of this tab is not grant administration.
    await revokeLocalIdentitySession(fixture.tomb, fixture.session.id);
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
    await revokeLocalIdentitySession(fixture.tomb, session.id);
    expect(await resolveCurrentAccessRole(fixture.tomb)).toBe("operator");
  });
});
