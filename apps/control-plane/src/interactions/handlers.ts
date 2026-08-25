import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { appendAuditEvent } from "@opensesame/audit";
import { createProvisionalPrincipal } from "@opensesame/auth-upstream";
import type { Awaitable } from "@opensesame/database";
import { parseOriginClientId } from "@opensesame/oauth-provider";
import {
  type Organization,
  type Principal,
  type ProvisionalSession,
  isString,
  overlapCast,
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
import {
  type ProviderDescriptor,
  normalizeIssuer,
  staticProviders,
} from "./registry.js";
import type {
  GrantHandle,
  InteractionDetails,
  ProviderInteractions,
} from "./types.js";

export interface ProvisionalInteractionCredentials {
  principalId: string;
  accessToken: string;
}

function interactionBase(uid: string): string {
  return `/interaction/${encodeURIComponent(uid)}`;
}

/**
 * Everything the login page needs that is not in the interaction itself: the
 * organization slug from `?org=<slug>`, and the re-render state a rejected
 * BYO / email / work-email submission hands back.
 */
export type LoginPageOptions = {
  /** `?org=<slug>` on the interaction GET (D6, second step). */
  orgSlug?: string;
  orgError?: string;
  byoError?: string;
  byoIssuer?: string;
  emailSent?: boolean;
  emailError?: string;
  realmError?: string;
};

/**
 * Resolve a provider hint (`kc_idp_hint` / `login_hint_provider`) against the
 * offered providers, id first (T7).
 *
 * Precedence is the whole point of this function existing: the day a real
 * `google` registry id sits next to shoo.dev's "Google" label, both match the
 * hint `google`, and the id — the thing a client actually asked for — must
 * win. A matched hint is rendered first and primary and never auto-submitted:
 * an upstream error 303s back to this page, so a page that redirected itself
 * would loop forever (T14).
 */
export function matchProviderHint(
  providers: readonly ProviderDescriptor[],
  hint: string | undefined,
): ProviderDescriptor | undefined {
  const needle = (hint ?? "").trim().toLowerCase();
  if (!needle) return undefined;
  const byId = providers.find(
    (provider) => provider.id.toLowerCase() === needle,
  );
  if (byId) return byId;
  const byIssuer = providers.find(
    (provider) => normalizeIssuer(provider.issuer).toLowerCase() === needle,
  );
  if (byIssuer) return byIssuer;
  const byHost = providers.find((provider) => {
    try {
      return new URL(provider.issuer).host.toLowerCase() === needle;
    } catch {
      return false;
    }
  });
  if (byHost) return byHost;
  return providers.find((provider) => provider.label.toLowerCase() === needle);
}

/**
 * The organization lookup the login page needs (C6). S6 lands `getBySlug` on
 * the organization store; until then `ctx.stores.organizations` is the
 * process-memory map that answers no such question, which is why the member
 * is optional here.
 *
 * INTEGRATOR: once S6 has landed, this view collapses to
 * `ctx.stores.organizations.getBySlug(slug)`.
 */
type OrganizationSlugLookup = {
  getBySlug(slug: string): Awaitable<Organization | undefined>;
};
type LoginPageStores = { organizations?: Partial<OrganizationSlugLookup> };

type OrganizationMethod = {
  issuer: string;
  label: string;
  kind: "sso" | "saml";
};

/**
 * The tenant's configured sign-in methods, as buttons. Mirrors
 * `tenantAuthMethods` in `routes/organizations.ts` (the public tenant
 * endpoint), so the hosted page and the Pages account switcher offer a tenant
 * the same choices under the same names.
 */
function organizationMethods(organization: Organization): OrganizationMethod[] {
  const methods: OrganizationMethod[] = [];
  if (organization.ssoIssuer) {
    methods.push({ kind: "sso", label: "SSO", issuer: organization.ssoIssuer });
  }
  if (organization.samlIssuer) {
    methods.push({
      kind: "saml",
      label: "SAML",
      issuer: organization.samlIssuer,
    });
  }
  return methods;
}

async function resolveOrganizationBlock(
  ctx: AppContext,
  base: string,
  options: LoginPageOptions,
): Promise<NonNullable<LoginPageModel["org"]>> {
  const lookupAction = `${base}/federated/org`;
  const slug = options.orgSlug?.trim();
  if (!slug) {
    return {
      lookupAction,
      ...(options.orgError !== undefined
        ? { error: options.orgError }
        : undefined),
    };
  }

  const stores: LoginPageStores = overlapCast(ctx.stores);
  const organizations = stores.organizations;
  const organization = organizations?.getBySlug
    ? await organizations.getBySlug(slug)
    : undefined;
  const methods =
    organization && organization.state !== "deleted"
      ? organizationMethods(organization)
      : [];
  if (methods.length === 0) {
    // One answer for "no such organization", "suspended" and "configured no
    // methods": the login page is unauthenticated, and telling a stranger
    // which slugs exist is an enumeration oracle.
    return {
      lookupAction,
      slug,
      error:
        options.orgError ??
        "No organization sign-in is configured for that name.",
    };
  }
  return {
    lookupAction,
    slug,
    methods,
    ...(options.orgError !== undefined
      ? { error: options.orgError }
      : undefined),
  };
}

export async function buildLoginPageModel(
  ctx: AppContext,
  details: InteractionDetails,
  csrfToken: string,
  principalId: string | undefined,
  options: LoginPageOptions = {},
): Promise<LoginPageModel> {
  const providers = staticProviders(ctx.config);
  // The SDK sends both spellings (packages/sdk-browser signIn({provider}));
  // oidc-provider only surfaces them because they are declared extraParams.
  const hint = isString(details.params.login_hint_provider)
    ? details.params.login_hint_provider
    : isString(details.params.kc_idp_hint)
      ? details.params.kc_idp_hint
      : undefined;
  const preferred = matchProviderHint(providers, hint);
  const base = interactionBase(details.uid);

  return {
    uid: details.uid,
    csrfToken,
    loginAction: `${base}/login`,
    ...(principalId !== undefined ? { principalId } : undefined),
    publicUrl: ctx.config.publicUrl,
    federated: {
      startAction: `${base}/federated/start`,
      upstreams: providers.map((provider) => ({
        issuer: provider.issuer,
        label: provider.label,
        provider: provider.id,
      })),
      ...(preferred !== undefined
        ? { preferredIssuer: preferred.issuer }
        : undefined),
    },
    byo: {
      startAction: `${base}/federated/byo`,
      ...(options.byoError !== undefined
        ? { error: options.byoError }
        : undefined),
      ...(options.byoIssuer !== undefined
        ? { issuerValue: options.byoIssuer }
        : undefined),
    },
    org: await resolveOrganizationBlock(ctx, base, options),
    email: {
      requestAction: `${base}/federated/email`,
      ...(options.emailSent !== undefined
        ? { sent: options.emailSent }
        : undefined),
      ...(options.emailError !== undefined
        ? { error: options.emailError }
        : undefined),
    },
    realm: {
      requestAction: `${base}/federated/realm`,
      ...(options.realmError !== undefined
        ? { error: options.realmError }
        : undefined),
    },
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
): Promise<ProvisionalInteractionCredentials> {
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
    // Durable once the organization store lands (C6): awaited so a failed
    // write surfaces here rather than as an unhandled rejection.
    await ensurePersonalOrganization(ctx, principal.id);
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
