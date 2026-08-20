import {
  digestUserCode,
  generateClaimToken,
  generateUserCode,
} from "../crypto/claim-token.js";
import { digestManifest } from "../crypto/digest.js";
import type {
  Agent,
  AgentInstance,
  ClaimItem,
  ClaimSession,
  DeviceAuthorizationSession,
  Principal,
  Project,
  ProvisionalSession,
  Resource,
} from "../types.js";

const FIXED_NOW = new Date("2026-08-07T06:00:00.000Z");
const PEPPER = "test-claim-pepper-not-for-production";

export const fixtures = {
  now: FIXED_NOW,
  pepper: PEPPER,

  provisionalPrincipal(overrides: Partial<Principal> = {}): Principal {
    return {
      id: "prn_test_provisional_001",
      state: "provisional",
      assurance: "provisional",
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      version: 1,
      ...overrides,
    };
  },

  verifiedPrincipal(overrides: Partial<Principal> = {}): Principal {
    return {
      id: "prn_test_verified_001",
      state: "active",
      assurance: "verified",
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      verifiedAt: FIXED_NOW,
      version: 2,
      ...overrides,
    };
  },

  provisionalProject(overrides: Partial<Project> = {}): Project {
    return {
      id: "prj_temp_001",
      kind: "temporary",
      slug: "temp-demo",
      displayName: "Temporary Demo",
      state: "provisional",
      ownerPrincipalId: "prn_test_provisional_001",
      expiresAt: new Date(FIXED_NOW.getTime() + 3_600_000),
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      ...overrides,
    };
  },

  /** Default personal project for a verified (or provisional) principal. */
  personalProject(overrides: Partial<Project> = {}): Project {
    return {
      id: "prj_personal_001",
      kind: "personal",
      slug: "personal",
      displayName: "Personal",
      state: "active",
      ownerPrincipalId: "prn_test_verified_001",
      sealedStoreTombName: "personal",
      pagesVaultFolderId: "vault_folder_personal",
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      ...overrides,
    };
  },

  provisionalResource(overrides: Partial<Resource> = {}): Resource {
    const manifest = { kind: "env", name: "demo" };
    return {
      id: "res_temp_001",
      projectId: "prj_temp_001",
      kind: "env",
      state: "provisional",
      ownerPrincipalId: "prn_test_provisional_001",
      manifest,
      expiresAt: new Date(FIXED_NOW.getTime() + 3_600_000),
      version: 1,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      ...overrides,
    };
  },

  provisionalSession(
    overrides: Partial<ProvisionalSession> = {},
  ): ProvisionalSession {
    return {
      id: "psess_001",
      principalId: "prn_test_provisional_001",
      quotaProfile: "anonymous_default",
      allowedActions: ["project.create_temporary", "resource.read"],
      createdAt: FIXED_NOW,
      expiresAt: new Date(FIXED_NOW.getTime() + 86_400_000),
      ...overrides,
    };
  },

  agent(overrides: Partial<Agent> = {}): Agent {
    return {
      id: "agt_001",
      ownerPrincipalId: "prn_test_provisional_001",
      displayName: "Example Agent",
      provider: "example",
      state: "provisional",
      createdAt: FIXED_NOW,
      ...overrides,
    };
  },

  agentInstance(overrides: Partial<AgentInstance> = {}): AgentInstance {
    return {
      id: "agti_001",
      agentId: "agt_001",
      publicKeyJkt: "jkt_test_thumbprint",
      createdAt: FIXED_NOW,
      ...overrides,
    };
  },

  pendingClaim(overrides: Partial<ClaimSession> = {}) {
    const manifest = {
      targets: [{ type: "project", id: "prj_temp_001" }],
      expiresAt: new Date(FIXED_NOW.getTime() + 3_600_000).toISOString(),
    };
    const generated = generateClaimToken(PEPPER, "claimpub001");
    const userCode = generateUserCode();
    const session: ClaimSession = {
      id: generated.publicId,
      type: "resource_bundle",
      state: "pending",
      creatorPrincipalId: "prn_test_provisional_001",
      tokenDigest: generated.digest,
      userCodeDigest: digestUserCode(PEPPER, generated.publicId, userCode),
      targetManifest: manifest,
      targetManifestDigest: digestManifest(manifest),
      createdAt: FIXED_NOW,
      expiresAt: new Date(FIXED_NOW.getTime() + 600_000),
      version: 1,
      ...overrides,
    };
    return { session, token: generated.token, userCode };
  },

  claimItems(claimId: string): ClaimItem[] {
    return [
      {
        id: "ci_project",
        claimId,
        targetType: "project",
        targetId: "prj_temp_001",
        required: true,
        dependencies: [],
        requestedAction: "transfer",
        state: "pending",
        snapshotVersion: 1,
        snapshotDigest: "sha256:proj1",
      },
      {
        id: "ci_resource",
        claimId,
        targetType: "resource",
        targetId: "res_temp_001",
        required: false,
        dependencies: ["ci_project"],
        requestedAction: "transfer",
        state: "pending",
        snapshotVersion: 1,
        snapshotDigest: "sha256:res1",
      },
    ];
  },

  pendingDeviceAuth(
    overrides: Partial<DeviceAuthorizationSession> = {},
  ): DeviceAuthorizationSession {
    return {
      id: "das_001",
      clientId: "cli_example",
      deviceCodeDigest: new Uint8Array(32).fill(1),
      userCodeDigest: new Uint8Array(32).fill(2),
      requestedScopes: ["openid", "profile"],
      requestedResources: [],
      state: "pending",
      intervalSeconds: 5,
      createdAt: FIXED_NOW,
      expiresAt: new Date(FIXED_NOW.getTime() + 600_000),
      pollCount: 0,
      ...overrides,
    };
  },
};

export type Fixtures = typeof fixtures;
