import {
  type BrowserDriver,
  BrowserStepExecutor,
  type BrowserStepPorts,
  CandidateCustody,
  DurableJournal,
  DurableResetRunner,
  type HumanChallenge,
  MemoryCheckpointJournal,
  RESET_ACTIONS,
  type ResetAction,
  type ResetEffects,
  type ResetRun,
  fixedGrants,
  resetAudience,
  resetResource,
} from "@opensesame/cua-password-reset";
/** Runner wiring shared by every sandbox-provider e2e. */
import type { AuthorityGrant } from "@opensesame/os-domain";
import type { PasswordMethod } from "@opensesame/vault-core";
import type { MockResetSite } from "./mock-site.js";

export const PEPPER = "person-pepper";

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
  changedAt: "2026-10-27T00:00:00.000Z",
};

function grant(action: ResetAction, domain: string): AuthorityGrant {
  const now = new Date();
  return {
    id: `grant:${action}`,
    version: 1,
    issuerPrincipalId: "person",
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
    resources: [resetResource(domain, "item-1")],
    constraints: {
      audiences: [resetAudience("run-1")],
      notBefore: null,
      expiresAt: new Date(now.getTime() + 600_000),
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
    createdAt: now,
    revokedAt: null,
  };
}

export function resetRun(site: MockResetSite, challenge = false): ResetRun {
  const domain = new URL(site.origin).hostname;
  return {
    id: "run-1",
    domain,
    origin: site.origin,
    itemId: "item-1",
    transport: "cdp",
    grantIds: Object.fromEntries(
      RESET_ACTIONS.map((action) => [action, `grant:${action}`]),
    ),
    cursor: 0,
    status: "running",
    updatedAt: new Date().toISOString(),
    recipe: {
      schemaVersion: 1,
      review: "approved",
      domain,
      entryPath: "/reset",
      allowedOrigins: [site.origin],
      steps: [
        { id: "open", primitive: "navigate", path: "/reset" },
        {
          id: "identify",
          primitive: "fill-field",
          ref: "e1",
          expectedLabel: "Email",
          purpose: "identifier",
        },
        {
          id: "request",
          primitive: "click",
          ref: "e2",
          expectedLabel: "Send reset link",
        },
        { id: "mail", primitive: "await-email-link" },
        ...(challenge
          ? [{ id: "challenge", primitive: "await-human" as const }]
          : []),
        {
          id: "password",
          primitive: "fill-field",
          ref: "e3",
          expectedLabel: "New password",
          purpose: "new-password",
        },
        {
          id: "submit",
          primitive: "submit",
          ref: "e4",
          expectedLabel: "Save password",
        },
        { id: "verify", primitive: "verify-login" },
      ],
    },
  };
}

export function runtimeForDriver(
  browser: BrowserDriver,
  site: MockResetSite,
  challenge = false,
) {
  const initial = resetRun(site, challenge);
  const provider = fixedGrants(
    Object.fromEntries(
      RESET_ACTIONS.map((action) => [action, grant(action, initial.domain)]),
    ),
  );
  const custody = new CandidateCustody(
    method,
    () => PEPPER,
    () => {
      const live = provider.grant("password_reset.password.produce", initial);
      if (live.actions[0] !== "password_reset.password.produce")
        throw new Error("Not authorized");
    },
  );
  const challenges: HumanChallenge[] = [];
  const verifyLogin = async (): Promise<boolean> =>
    custody.withPassword(async (password) => {
      const response = await fetch(`${site.origin}/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          email: "person@example.test",
          password,
        }),
      });
      return response.headers.get("location") === "/account";
    });
  const ports: BrowserStepPorts = {
    identifier: async () => "person@example.test",
    mailbox: { resetLink: async () => site.resetLink() },
    candidate: custody,
    authorizeProxy: () => {
      provider.grant("password_reset.proxy.substitute", initial);
    },
    takeover: {
      handoff: async (seen) => {
        challenges.push(seen);
      },
      resume: async () => {
        await fetch(`${site.origin}/challenge/clear`, {
          method: "POST",
          redirect: "manual",
        });
        await browser.open(site.resetLink());
      },
    },
    verifyLogin,
  };
  const executor = new BrowserStepExecutor(browser, ports);
  const effects: ResetEffects = {
    execute: (step, current, context) =>
      executor.execute(step, current, context),
    backupCandidate: async () => {},
    verifyCandidate: async () =>
      (await verifyLogin()) ? "verified" : "not_active",
    promoteCandidate: async () => {},
    compensate: async () => {
      site.restorePassword();
      return "compensated" as const;
    },
  };
  const store = new MemoryCheckpointJournal();
  const journal = new DurableJournal(store);
  return {
    initial,
    custody,
    challenges,
    journal,
    store,
    runner: new DurableResetRunner(journal, effects, provider),
  };
}

export async function expectNewPasswordAccepted(
  custody: CandidateCustody,
  site: MockResetSite,
): Promise<void> {
  const accepted = await custody.withPassword(async (password) =>
    site.accepts(password),
  );
  if (!accepted) throw new Error("site does not accept the new password");
  if (site.accepts("old-password"))
    throw new Error("site still accepts the old password");
}
