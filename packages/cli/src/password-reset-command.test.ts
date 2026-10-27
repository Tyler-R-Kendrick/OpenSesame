import type { VaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { WebStorage } from "@opensesame/app-core/ports.js";
import {
  type ResetAction,
  type ResetEffects,
  domainMetadataResource,
  resetAudience,
  resetResource,
} from "@opensesame/cua-password-reset";
import { type AuthorityGrant, overlapCast } from "@opensesame/os-domain";
import type { AccountItem, PasswordMethod } from "@opensesame/vault-core";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());
import type { ResetApprovalSession } from "./password-reset-approvals.js";
import {
  type PasswordResetDependencies,
  runPasswordReset,
} from "./password-reset-command.js";
import type { LoadedResetConfiguration } from "./password-reset-config.js";
import type { PasswordResetCommand } from "./password-reset-parse.js";

const ORIGIN = "https://accounts.example.test";
const NOW = new Date("2026-10-27T00:00:00.000Z");
const method: PasswordMethod = {
  id: "password-1",
  type: "password",
  generator: {
    id: "derived",
    counter: 1,
    rules: {
      length: 24,
      lower: true,
      upper: true,
      digits: true,
      symbols: true,
      avoidAmbiguous: false,
      minDigits: 1,
      minSymbols: 1,
    },
  },
  pepper: true,
  pepperAt: "end",
  secret: Buffer.alloc(32, 7).toString("base64"),
  changedAt: NOW.toISOString(),
};
const item: AccountItem = {
  id: "item-1",
  kind: "account",
  name: "Example",
  folderId: null,
  favorite: false,
  notes: "",
  fields: [],
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  deletedAt: null,
  username: "person@example.test",
  uris: [],
  methods: [method],
};

function loaded(): LoadedResetConfiguration {
  return {
    directory: "/tmp/reset-test",
    config: {
      schemaVersion: 1,
      origin: ORIGIN,
      itemId: item.id,
      transport: "cdp",
      recipe: "recipe.json",
      runtime: {
        module: "runtime.mjs",
        resource: "https://runtime.example.test",
        model: "decision-model",
        modelBaseURL: "https://model.example.test/v1",
        modelKeyEnv: "RESET_MODEL_KEY",
        browser: "/opt/user/agent-browser",
        maxSteps: 40,
      },
    },
    recipe: {
      schemaVersion: 1,
      review: "approved",
      domain: "accounts.example.test",
      entryPath: "/reset",
      allowedOrigins: [ORIGIN],
      steps: [
        {
          id: "password",
          primitive: "fill-field",
          ref: "e1",
          purpose: "new-password",
        },
        { id: "submit", primitive: "submit", ref: "e2" },
        { id: "verify", primitive: "verify-login" },
      ],
    },
  };
}

function grant(action: ResetAction): AuthorityGrant {
  return {
    id: `reset-${action}`,
    version: 1,
    issuerPrincipalId: "owner",
    beneficiaryPrincipalId: "agent",
    actorId: null,
    clientId: null,
    actorInstanceId: "agent-instance-1",
    proofKeyThumbprint: "proof-key-1",
    organizationId: "org",
    projectId: null,
    environmentId: null,
    connectionId: null,
    actions: [action],
    resources: [
      action === "password_reset.domain_metadata.list"
        ? domainMetadataResource("accounts.example.test")
        : resetResource("accounts.example.test", item.id),
    ],
    constraints: {
      audiences: [resetAudience("run-1")],
      notBefore: null,
      expiresAt: new Date(NOW.getTime() + 60_000),
      requiredAssurance: null,
      authenticationMaxAgeSeconds: null,
      allowedNetworks: [],
      parameterRulesDigest: null,
      budgets: {},
      maximumDelegationDepth: 0,
      offlineUse: "forbidden",
      rawCredentialExport: false,
    },
    parentGrantId: null,
    delegationDepth: 0,
    createdAt: NOW,
    revokedAt: null,
  };
}

function approvals(actions: ResetAction[]): ResetApprovalSession {
  return {
    approve: vi.fn(async (action: ResetAction) => {
      actions.push(action);
      const approval = { grant: grant(action) };
      return action === "password_reset.domain_metadata.list"
        ? {
            ...approval,
            items: [{ id: item.id, name: item.name, origins: [ORIGIN] }],
          }
        : approval;
    }),
    status: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function storage(): WebStorage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

function vaultStore(): VaultStore {
  return overlapCast({ lock: vi.fn() });
}

function command(action: PasswordResetCommand["action"]): PasswordResetCommand {
  return {
    name: "password-reset",
    action,
    config: "reset.json",
    runId: "run-1",
    flags: { json: true },
  };
}

describe("password reset command", () => {
  it("approves metadata then each capability and asks for fresh pepper", async () => {
    const actions: ResetAction[] = [];
    const approvalSession = approvals(actions);
    const local = storage();
    const readPassword = vi.fn(async () => "fresh-human-pepper");
    const filled: string[] = [];
    const effects: ResetEffects = {
      execute: vi.fn<ResetEffects["execute"]>(async (step) => {
        if (step.primitive === "fill-field") filled.push(step.id);
        return { stepId: step.id, outcome: "completed" };
      }),
      backupCandidate: vi.fn(async () => undefined),
      verifyCandidate: vi.fn<ResetEffects["verifyCandidate"]>(
        async () => "verified",
      ),
      promoteCandidate: vi.fn(async () => undefined),
      compensate: vi.fn<ResetEffects["compensate"]>(async () => "compensated"),
    };
    const deps: PasswordResetDependencies = {
      loadConfiguration: async () => loaded(),
      openApprovals: async () => approvalSession,
      openVault: async () => ({
        store: vaultStore(),
        item,
        method,
        local,
      }),
      loadEffects: async ({ candidate }) => ({
        ...effects,
        execute: async (step, run, context) => {
          if (step.primitive === "fill-field")
            await candidate.withPassword(async (password) => {
              filled.push(password);
            });
          return effects.execute(step, run, context);
        },
      }),
      createAgent: () => ({ headers: vi.fn(), forget: vi.fn() }),
      readPassword,
      now: () => NOW,
      newRunId: () => "run-1",
    };
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await expect(runPasswordReset(command("run"), deps)).resolves.toBe(0);
    expect(actions[0]).toBe("password_reset.domain_metadata.list");
    expect(actions).toEqual(
      expect.arrayContaining([
        "password_reset.item.use",
        "password_reset.runtime.execute",
        "password_reset.model.plan",
        "password_reset.browser.drive",
        "password_reset.password.produce",
        "password_reset.human.takeover",
      ]),
    );
    expect(new Set(actions).size).toBe(actions.length);
    expect(readPassword).toHaveBeenCalledOnce();
    const produced = filled.find((value) =>
      value.endsWith("fresh-human-pepper"),
    );
    expect(produced).toBeDefined();
    expect(JSON.stringify(stdout.mock.calls)).not.toContain(produced);
    expect(JSON.stringify(local)).not.toContain("fresh-human-pepper");
    expect(approvalSession.close).toHaveBeenCalledOnce();
  });

  it("refuses to open the vault when domain metadata does not share the exact item", async () => {
    const approvalSession = approvals([]);
    approvalSession.approve = vi.fn(async (action: ResetAction) => ({
      grant: grant(action),
      items: [],
    }));
    const openVault = vi.fn();
    await expect(
      runPasswordReset(command("run"), {
        loadConfiguration: async () => loaded(),
        openApprovals: async () => approvalSession,
        openVault,
        now: () => NOW,
      }),
    ).rejects.toThrow("password-reset run failed");
    expect(openVault).not.toHaveBeenCalled();
    expect(approvalSession.close).toHaveBeenCalledOnce();
  });

  it("resumes a human wait only through the resume command", async () => {
    const local = storage();
    const actions: ResetAction[] = [];
    let waiting = true;
    const deps: PasswordResetDependencies = {
      loadConfiguration: async () => loaded(),
      openApprovals: async () => approvals(actions),
      openVault: async () => ({
        store: vaultStore(),
        item,
        method,
        local,
      }),
      loadEffects: async () => ({
        execute: async (step) => ({
          stepId: step.id,
          outcome:
            waiting && step.primitive === "fill-field"
              ? "waiting"
              : "completed",
        }),
        backupCandidate: async () => undefined,
        verifyCandidate: async () => "verified",
        promoteCandidate: async () => undefined,
        compensate: async () => "compensated",
      }),
      createAgent: () => ({ headers: vi.fn(), forget: vi.fn() }),
      now: () => NOW,
    };
    expect(await runPasswordReset(command("run"), deps)).toBe(0);
    waiting = false;
    expect(await runPasswordReset(command("resume"), deps)).toBe(0);
    expect(
      actions.filter((action) => action === "password_reset.human.takeover"),
    ).toHaveLength(2);
  });

  it("reconciles an indeterminate submit without dispatching another submit", async () => {
    const local = storage();
    const actions: ResetAction[] = [];
    let submissions = 0;
    let reconciling = false;
    const verifyCandidate = vi.fn<ResetEffects["verifyCandidate"]>(
      async () => "verified",
    );
    const deps: PasswordResetDependencies = {
      loadConfiguration: async () => loaded(),
      openApprovals: async () => approvals(actions),
      openVault: async () => ({
        store: vaultStore(),
        item,
        method,
        local,
      }),
      loadEffects: async () => ({
        execute: async (step) => {
          if (step.primitive === "submit") submissions += 1;
          return {
            stepId: step.id,
            outcome:
              step.primitive === "submit" && !reconciling
                ? "submit_indeterminate"
                : "completed",
          };
        },
        backupCandidate: async () => undefined,
        verifyCandidate,
        promoteCandidate: async () => undefined,
        compensate: async () => "compensated",
      }),
      createAgent: () => ({ headers: vi.fn(), forget: vi.fn() }),
      now: () => NOW,
    };
    expect(await runPasswordReset(command("run"), deps)).toBe(0);
    reconciling = true;
    expect(await runPasswordReset(command("reconcile"), deps)).toBe(0);
    expect(submissions).toBe(1);
    expect(verifyCandidate).toHaveBeenCalledOnce();
    expect(actions).toContain("password_reset.run.reconcile");
  });
});
