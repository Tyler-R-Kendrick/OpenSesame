import { createHmac } from "node:crypto";
import { hostname } from "node:os";
import type { DeviceResetGrant } from "@opensesame/app-core/lib/live/device-reset-messages.js";
import {
  type DeviceSession,
  joinAsDevice,
} from "@opensesame/app-core/lib/live/device-session.js";
import { parseLiveLink } from "@opensesame/app-core/lib/live/link.js";
import {
  type ResetAction,
  type ResetRun,
  domainMetadataResource,
  resetAudience,
  resetResource,
} from "@opensesame/cua-password-reset";
import type { AuthorityGrant } from "@opensesame/os-domain";
import { natsNodeCarriers } from "./live-nats.js";
import type { LoadedResetConfiguration } from "./password-reset-config.js";
import type { PasswordResetCommand } from "./password-reset-parse.js";

export type ResetApproval = {
  grant: AuthorityGrant;
  items?: DeviceResetGrant["items"];
};

export interface ResetApprovalSession {
  approve(
    action: ResetAction,
    run: ResetRun,
    loaded: LoadedResetConfiguration,
  ): Promise<ResetApproval>;
  status(
    run: ResetRun,
    action: ResetAction,
    status: "takeover_requested",
  ): Promise<void>;
  close(): Promise<void>;
}

type ResetAgentIdentity = Readonly<{
  actorInstanceId: string;
  proofKeyThumbprint: string;
}>;

function requestId(run: ResetRun, action: ResetAction): string {
  const key = `opensesame.password-reset.approval-request.v1:${run.id}`;
  return createHmac("sha256", key).update(action).digest("hex").slice(0, 24);
}

function projection(
  reply: DeviceResetGrant,
  run: ResetRun,
  action: ResetAction,
  identity: ResetAgentIdentity,
): AuthorityGrant {
  const resource =
    action === "password_reset.domain_metadata.list"
      ? domainMetadataResource(run.domain)
      : resetResource(run.domain, run.itemId);
  return {
    id: reply.grant,
    version: 1,
    issuerPrincipalId: "live-owner",
    beneficiaryPrincipalId: "agent-local",
    actorId: null,
    clientId: null,
    actorInstanceId: identity.actorInstanceId,
    proofKeyThumbprint: identity.proofKeyThumbprint,
    organizationId: "local-password-reset",
    projectId: null,
    environmentId: null,
    connectionId: null,
    actions: [action],
    resources: [resource],
    constraints: {
      audiences: [resetAudience(run.id)],
      notBefore: new Date(Date.now() - 1000),
      expiresAt: new Date(reply.expiresAt),
      requiredAssurance: null,
      authenticationMaxAgeSeconds: null,
      allowedNetworks: [],
      parameterRulesDigest: reply.digest,
      budgets: {},
      maximumDelegationDepth: 0,
      offlineUse: "forbidden",
      rawCredentialExport: false,
    },
    parentGrantId: null,
    delegationDepth: 0,
    createdAt: new Date(),
    revokedAt: null,
  };
}

export class LiveResetApprovals implements ResetApprovalSession {
  constructor(
    private readonly session: DeviceSession,
    private readonly identity: ResetAgentIdentity,
  ) {}

  async approve(
    action: ResetAction,
    run: ResetRun,
    loaded: LoadedResetConfiguration,
  ): Promise<ResetApproval> {
    const req = requestId(run, action);
    const reply = await this.session.client.reset(req, {
      origin: run.origin,
      item:
        action === "password_reset.domain_metadata.list"
          ? "metadata"
          : run.itemId,
      runtime: "agent-browser",
      model: loaded.config.runtime.model ?? "local recipe replay (no model)",
      expiresAt: Date.now() + 15 * 60_000,
      actions: [action],
    });
    const approval: ResetApproval = {
      grant: projection(reply, run, action, this.identity),
    };
    if (reply.items !== undefined) approval.items = reply.items;
    return approval;
  }

  async status(
    run: ResetRun,
    action: ResetAction,
    status: "takeover_requested",
  ): Promise<void> {
    const req = requestId(run, action);
    await this.session.client.resetStatus(
      `status-${req}`.slice(0, 32),
      `reset-${req}`,
      status,
    );
  }

  async close(): Promise<void> {
    await this.session.leave();
  }
}

export async function openResetApprovals(
  _command: PasswordResetCommand,
): Promise<ResetApprovalSession> {
  const raw = process.env.OPENSESAME_LIVE_LINK;
  if (!raw)
    throw new Error("OPENSESAME_LIVE_LINK is required for reset approval");
  const actorInstanceId = process.env.OPENSESAME_AGENT_INSTANCE;
  const proofKeyThumbprint = process.env.OPENSESAME_AGENT_PROOF_KEY;
  if (!actorInstanceId || !proofKeyThumbprint)
    throw new Error(
      "Agent instance and public proof-key thumbprint are required",
    );
  const link = parseLiveLink(raw);
  if (!link) throw new Error("The reset live-session link is invalid");
  const session = await joinAsDevice({
    link,
    code: process.env.OPENSESAME_LIVE_CODE ?? null,
    name: `opensesame-id password reset on ${hostname()}`,
    carriers: natsNodeCarriers(),
    replyMs: 15 * 60_000,
  });
  return new LiveResetApprovals(session, {
    actorInstanceId,
    proofKeyThumbprint,
  });
}
