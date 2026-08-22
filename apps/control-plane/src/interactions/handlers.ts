import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { appendAuditEvent } from "@opensesame/audit";
import { createProvisionalPrincipal } from "@opensesame/auth-upstream";
import { parseOriginClientId } from "@opensesame/oauth-provider";
import {
  type Principal,
  type ProvisionalSession,
  isString,
} from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import { ensurePersonalOrganization } from "../routes/organizations.js";
import {
  MAX_PROVISIONAL,
  consumeProvisionalMintBudget,
} from "../routes/principals.js";
import {
  type ConsentPageModel,
  type LoginPageModel,
  collectConsentScopes,
} from "../ui/interaction-pages.js";
import type {
  GrantHandle,
  InteractionDetails,
  ProviderInteractions,
} from "./types.js";

function interactionBase(uid: string): string {
  return `/interaction/${encodeURIComponent(uid)}`;
}

export function buildLoginPageModel(
  ctx: AppContext,
  details: InteractionDetails,
  csrfToken: string,
  principalId: string | undefined,
): LoginPageModel {
  return {
    uid: details.uid,
    csrfToken,
    loginAction: `${interactionBase(details.uid)}/login`,
    ...(principalId !== undefined ? { principalId } : undefined),
    publicUrl: ctx.config.publicUrl,
  };
}

export async function buildConsentPageModel(
  ctx: AppContext,
  details: InteractionDetails,
  csrfToken: string,
): Promise<ConsentPageModel> {
  const clientId = String(details.params.client_id ?? "");
  const clientRecord = await ctx.oauth.clientStore.findById(clientId);
  const parsedOrigin = parseOriginClientId(clientId);
  const origin = clientRecord?.origin ?? parsedOrigin ?? clientId;
  const scopes = collectConsentScopes(
    isString(details.params.scope) ? details.params.scope : undefined,
    details.prompt.details?.missingOIDCScope,
  );

  return {
    uid: details.uid,
    csrfToken,
    confirmAction: `${interactionBase(details.uid)}/confirm`,
    abortAction: `${interactionBase(details.uid)}/abort`,
    origin,
    showAutoAdmitted:
      clientRecord?.admissionMode === "origin_profile" &&
      (clientRecord.ownershipStatus ?? "unclaimed") === "unclaimed",
    scopes,
    ...(clientRecord?.displayName !== undefined
      ? { clientDisplayName: clientRecord.displayName }
      : undefined),
  };
}

/** The provisional mint was refused (capacity or rate budget). */
export class ProvisionalMintRefusedError extends Error {
  override readonly name = "ProvisionalMintRefusedError";
  readonly code: "provisional_capacity" | "rate_limited";

  constructor(code: "provisional_capacity" | "rate_limited") {
    super(code);
    this.code = code;
  }
}

/**
 * Mint a provisional principal + session for the interaction login page.
 * Mirrors `POST /v1/principals/provisional` (same capacity fence, same mint
 * budget, same durable rows, same audit event) so the browser flow does not
 * become a softer back door around the public mint route.
 */
export async function mintProvisionalForInteraction(
  ctx: AppContext,
  fingerprint: string,
  correlationId: string,
): Promise<{ principalId: string; accessToken: string }> {
  const now = ctx.clock();

  if (ctx.stores.provisionalSessions.size >= MAX_PROVISIONAL) {
    throw new ProvisionalMintRefusedError("provisional_capacity");
  }
  if (
    !consumeProvisionalMintBudget(
      ctx.stores.provisionalMints,
      fingerprint,
      now.getTime(),
    )
  ) {
    throw new ProvisionalMintRefusedError("rate_limited");
  }

  const { mapping, session } = await createProvisionalPrincipal(ctx.mappings, {
    ttlMs: ctx.config.provisionalTtlMs,
    quotaProfile: "anonymous",
    allowedActions: [
      "project.create",
      "project.create_temporary",
      "resource.create_temporary",
      "claim.create",
      "agent.register_ephemeral",
      "session.continue_anonymous",
    ],
  });

  const provisionalSession: ProvisionalSession = {
    ...session,
    createdAt: now,
    expiresAt: new Date(now.getTime() + ctx.config.provisionalTtlMs),
  };
  const principal: Principal = {
    id: mapping.principalId,
    state: "provisional",
    assurance: "provisional",
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  try {
    await ctx.repos.principals.create(principal);
    await ctx.repos.betterAuthSubjects.link({
      betterAuthUserId: mapping.betterAuthUserId,
      principalId: mapping.principalId,
      linkedAt: now,
    });
  } catch (error) {
    await ctx.repos.principals.deleteUnlinkedProvisional(principal.id);
    await ctx.mappings.deleteProvisional(principal.id);
    throw error;
  }

  if (ctx.config.bootstrapPersonalOrganization) {
    ensurePersonalOrganization(ctx, principal.id);
  }

  const accessToken = `pst_${randomBytes(24).toString("base64url")}`;
  ctx.stores.provisionalSessions.set(provisionalSession.id, provisionalSession);
  ctx.stores.provisionalTokens.set(accessToken, provisionalSession.id);

  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "principal.provisional_created",
    outcome: "succeeded",
    principalId: principal.id,
    sessionId: provisionalSession.id,
    correlationId,
    actorType: "human",
    metadata: {
      action: "principal.provisional_create",
      quotaProfile: "anonymous",
      via: "interaction_login",
    },
  });

  return { principalId: principal.id, accessToken };
}

/** Finish the login prompt; returns the oidc-provider resume URL. */
export async function finishLoginInteraction(
  provider: ProviderInteractions,
  req: IncomingMessage,
  res: ServerResponse,
  accountId: string,
): Promise<string> {
  return provider.interactionResult(
    req,
    res,
    { login: { accountId } },
    { mergeWithLastSubmission: false },
  );
}

/** Abort the consent prompt with access_denied; returns the resume URL. */
export async function finishConsentDeny(
  ctx: AppContext,
  provider: ProviderInteractions,
  req: IncomingMessage,
  res: ServerResponse,
  details: InteractionDetails,
  correlationId: string,
): Promise<string> {
  const returnTo = await provider.interactionResult(
    req,
    res,
    {
      error: "access_denied",
      error_description: "End-User denied consent",
    },
    { mergeWithLastSubmission: false },
  );
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "oauth.consent_denied",
    outcome: "succeeded",
    ...(details.session?.accountId
      ? { principalId: details.session.accountId }
      : undefined),
    correlationId,
    actorType: "human",
    metadata: { clientId: String(details.params.client_id ?? "") },
  });
  return returnTo;
}

/**
 * Confirm consent: build/merge the oidc-provider Grant, persist the durable
 * consent record (ADR 0034 §3 — remembered, widening, revocable), and finish
 * the interaction. Returns the resume URL.
 */
export async function finishConsentAllow(
  ctx: AppContext,
  provider: ProviderInteractions,
  req: IncomingMessage,
  res: ServerResponse,
  details: InteractionDetails,
  correlationId: string,
): Promise<string> {
  const { prompt, grantId, session, params } = details;
  if (prompt.name !== "consent") {
    throw new Error("expected consent prompt");
  }
  const clientId = String(params.client_id ?? "");
  const accountId = session?.accountId;
  if (!accountId) throw new Error("missing session accountId for consent");

  let grant: GrantHandle;

  if (grantId) {
    const existingGrant = await provider.Grant.find(grantId);
    if (!existingGrant) throw new Error("grant not found");
    grant = existingGrant;
  } else {
    grant = new provider.Grant({ accountId, clientId });
  }

  const missingScope = prompt.details?.missingOIDCScope;
  if (missingScope?.length) {
    grant.addOIDCScope(missingScope.join(" "));
  }
  const missingClaims = prompt.details?.missingOIDCClaims;
  if (missingClaims?.length) {
    grant.addOIDCClaims(missingClaims);
  }
  const missingResource = prompt.details?.missingResourceScopes;
  if (missingResource) {
    for (const [indicator, scopeList] of Object.entries(missingResource)) {
      grant.addResourceScope(indicator, scopeList.join(" "));
    }
  }

  const savedGrantId = await grant.save();

  // The durable consent record: what the human agreed to, per principal and
  // client. The oidc Grant above is what skips the next prompt; this row is
  // what revocation and audit can see. A widened request widens this row.
  const clientRecord = await ctx.oauth.clientStore.findById(clientId);
  const scopes = collectConsentScopes(
    isString(params.scope) ? params.scope : undefined,
    missingScope,
  );
  await ctx.stores.consents.save({
    principalId: accountId,
    clientId,
    sectorIdentifier: clientRecord?.sectorIdentifier ?? clientId,
    scopes,
    resources: Object.keys(missingResource ?? {}).sort(),
    claims: [...(missingClaims ?? [])].sort(),
    grantedAt: ctx.clock(),
  });

  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "oauth.consent_granted",
    outcome: "succeeded",
    principalId: accountId,
    correlationId,
    actorType: "human",
    metadata: { clientId, scopes },
  });

  return provider.interactionResult(
    req,
    res,
    { consent: { grantId: savedGrantId } },
    { mergeWithLastSubmission: true },
  );
}
