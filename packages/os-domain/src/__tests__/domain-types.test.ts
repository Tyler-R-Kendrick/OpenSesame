import { describe, expect, it } from "vitest";
import { NoopAbuseChallengeProvider } from "../index.js";
import { fixtures } from "./fixtures.js";

describe("NoopAbuseChallengeProvider", () => {
  it("always allows the action", async () => {
    const provider = new NoopAbuseChallengeProvider();
    await expect(provider.challenge()).resolves.toEqual({ allowed: true });
  });
});

describe("domain fixtures", () => {
  it("builds a verified principal distinct from a provisional one", () => {
    const verified = fixtures.verifiedPrincipal();
    expect(verified.state).toBe("active");
    expect(verified.assurance).toBe("verified");
    expect(verified.verifiedAt).toEqual(fixtures.now);
    expect(verified.id).not.toBe(fixtures.provisionalPrincipal().id);
  });

  it("builds a temporary project with a TTL", () => {
    const project = fixtures.provisionalProject();
    expect(project.kind).toBe("temporary");
    expect(project.state).toBe("provisional");
    expect(project.expiresAt?.getTime()).toBeGreaterThan(
      fixtures.now.getTime(),
    );
  });

  it("builds a personal project with canonical bindings", () => {
    const project = fixtures.personalProject();
    expect(project.kind).toBe("personal");
    expect(project.slug).toBe("personal");
    expect(project.sealedStoreTombName).toBe("personal");
    expect(project.pagesVaultFolderId).toBe("vault_folder_personal");
  });

  it("builds a provisional session scoped to the provisional principal", () => {
    const session = fixtures.provisionalSession();
    expect(session.principalId).toBe(fixtures.provisionalPrincipal().id);
    expect(session.allowedActions).toContain("project.create_temporary");
    expect(session.expiresAt.getTime()).toBeGreaterThan(fixtures.now.getTime());
  });

  it("builds an agent owned by the provisional principal", () => {
    const agent = fixtures.agent();
    expect(agent.ownerPrincipalId).toBe(fixtures.provisionalPrincipal().id);
    expect(agent.state).toBe("provisional");
  });

  it("builds an agent instance bound to its agent", () => {
    const instance = fixtures.agentInstance();
    expect(instance.agentId).toBe(fixtures.agent().id);
    expect(instance.publicKeyJkt).toBe("jkt_test_thumbprint");
  });
});
