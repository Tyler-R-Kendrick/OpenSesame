import { createHash, randomUUID } from "node:crypto";
import { appendAuditEvent, redactAuditMetadata } from "@opensesame/audit";
import {
  AuthenticationServiceError,
  DEFAULT_AUTHENTICATION_CONFIGURATIONS,
  authenticationApplicationSecretMatches,
  mintAuthenticationApplicationSecret,
  visibleAuthenticationAlias,
} from "@opensesame/auth-upstream";
import {
  AuthenticationConfigurationApplicationRequestSchema,
  AuthenticationConfigurationRequestSchema,
  AuthenticationCredentialsRequestSchema,
  AuthenticationOptionsRequestSchema,
  AuthenticationRegistrationOptionsRequestSchema,
  AuthenticationRegistrationVerifyRequestSchema,
  AuthenticationTokenVerifyRequestSchema,
  AuthenticationVerifyRequestSchema,
  CreateAuthenticationApplicationRequestSchema,
  CreateRegistrationTokenRequestSchema,
  DeleteAuthenticationCredentialRequestSchema,
  GenerateAuthenticationTokenRequestSchema,
  PatchAuthenticationApiKeyRequestSchema,
  PatchAuthenticationApplicationRequestSchema,
  RenameAuthenticationCredentialRequestSchema,
  SendAuthenticationMagicLinkRequestSchema,
  SetAuthenticationAliasesRequestSchema,
} from "@opensesame/contracts";
import type { AuthenticationApplication } from "@opensesame/os-domain";
import { overlapCast } from "@opensesame/os-domain";
import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { authenticatedPrincipalId } from "./organizations.js";

export const authenticationServiceRoutes = new Hono<{ Variables: Variables }>();

const PUBLIC_WINDOW_MS = 60_000;
const PUBLIC_CLIENT_BUDGET = 60;
const PUBLIC_GLOBAL_BUDGET = 1_000;
const PUBLIC_FENCE_ENTRIES = 4_096;

function consumePublicBudget(c: {
  req: { header: (name: string) => string | undefined };
  get: (name: "ctx") => AppContext;
}): boolean {
  const now = Date.now();
  const map = c.get("ctx").stores.authenticationAnon;
  for (const [key, values] of map) {
    const live = values.filter((at) => now - at < PUBLIC_WINDOW_MS);
    if (live.length === 0) map.delete(key);
    else if (live.length !== values.length) map.set(key, live);
  }
  while (map.size > PUBLIC_FENCE_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  const fingerprint = createHash("sha256")
    .update(c.req.header("user-agent") ?? "")
    .update("|")
    .update(c.req.header("origin") ?? c.req.header("x-forwarded-for") ?? "")
    .digest("hex")
    .slice(0, 16);
  const global = map.get("__global__") ?? [];
  const client = map.get(fingerprint) ?? [];
  if (
    global.length >= PUBLIC_GLOBAL_BUDGET ||
    client.length >= PUBLIC_CLIENT_BUDGET
  ) {
    return false;
  }
  map.set("__global__", [...global, now]);
  map.set(fingerprint, [...client, now]);
  return true;
}

function applicationResponse(application: AuthenticationApplication) {
  return {
    id: application.id,
    ownerPrincipalId: application.ownerPrincipalId,
    organizationId: application.organizationId ?? null,
    displayName: application.displayName,
    rpId: application.rpId,
    origins: application.origins,
    secretPrefix: application.secretPrefix,
    apiKeys: application.apiKeys.map(
      ({ id, secretPrefix, state, createdAt }) => ({
        id,
        secretPrefix,
        state,
        createdAt,
      }),
    ),
    configurations: application.configurations,
    manualTokensEnabled: application.manualTokensEnabled,
    magicLinksEnabled: application.magicLinksEnabled,
    state: application.state,
    createdAt: application.createdAt.toISOString(),
    updatedAt: application.updatedAt.toISOString(),
  };
}

async function canManage(
  ctx: AppContext,
  application: AuthenticationApplication,
  principalId: string,
): Promise<boolean> {
  if (application.ownerPrincipalId === principalId) return true;
  if (!application.organizationId) return false;
  const membership = await ctx.stores.organizationMemberships.find(
    application.organizationId,
    principalId,
  );
  return membership?.role === "owner" || membership?.role === "admin";
}

async function managedApplication(
  ctx: AppContext,
  applicationId: string,
  principalId: string,
): Promise<AuthenticationApplication | undefined> {
  const application =
    await ctx.authenticationStores.applications.get(applicationId);
  return application && (await canManage(ctx, application, principalId))
    ? application
    : undefined;
}

function presentedSecret(header: string | undefined): string | undefined {
  if (!header?.toLowerCase().startsWith("bearer ")) return undefined;
  const value = header.slice(7).trim();
  return value.startsWith("osa_") ? value : undefined;
}

async function backendApplication(
  ctx: AppContext,
  applicationId: string,
  authorization: string | undefined,
): Promise<AuthenticationApplication | undefined> {
  const secret = presentedSecret(authorization);
  if (!secret) return undefined;
  const application =
    await ctx.authenticationStores.applications.get(applicationId);
  if (!application || application.state !== "active") return undefined;
  return authenticationApplicationSecretMatches(application, secret)
    ? application
    : undefined;
}

function serviceError(error: AuthenticationServiceError): Response {
  const status = (() => {
    switch (error.code) {
      case "application_not_found":
      case "configuration_not_found":
      case "unknown_credential":
        return 404;
      case "application_inactive":
      case "feature_disabled":
      case "invalid_token":
      case "origin_not_allowed":
        return 403;
      case "registration_conflict":
        return 409;
      default:
        return 400;
    }
  })();
  return Response.json({ error: error.code }, { status });
}

async function assertVerifiedPrincipal(
  ctx: AppContext,
  principalId: string,
): Promise<boolean> {
  const principal = await ctx.repos.principals.getById(principalId);
  return Boolean(principal && principal.assurance !== "provisional");
}

async function assertOrganizationAdmin(
  ctx: AppContext,
  organizationId: string,
  principalId: string,
): Promise<boolean> {
  const organization = await ctx.stores.organizations.get(organizationId);
  if (!organization || organization.state !== "active") return false;
  const membership = await ctx.stores.organizationMemberships.find(
    organizationId,
    principalId,
  );
  return membership?.role === "owner" || membership?.role === "admin";
}

authenticationServiceRoutes.get(
  "/applications",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const applications = new Map<string, AuthenticationApplication>();
    for (const application of await ctx.authenticationStores.applications.listByOwner(
      principalId,
    )) {
      applications.set(application.id, application);
    }
    for (const membership of await ctx.stores.organizationMemberships.listByPrincipal(
      principalId,
    )) {
      if (membership.role !== "owner" && membership.role !== "admin") continue;
      for (const application of await ctx.authenticationStores.applications.listByOrganization(
        membership.organizationId,
      )) {
        applications.set(application.id, application);
      }
    }
    return c.json({
      applications: [...applications.values()].map(applicationResponse),
    });
  },
);

authenticationServiceRoutes.post(
  "/applications",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    if (!(await assertVerifiedPrincipal(ctx, principalId))) {
      return c.json({ error: "verified_identity_required" }, 403);
    }
    const parsed = CreateAuthenticationApplicationRequestSchema.safeParse(
      await c.req.json(),
    );
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }
    if (
      parsed.data.organizationId &&
      !(await assertOrganizationAdmin(
        ctx,
        parsed.data.organizationId,
        principalId,
      ))
    ) {
      return c.json({ error: "admin_required" }, 403);
    }
    const now = ctx.clock();
    const minted = mintAuthenticationApplicationSecret();
    const application: AuthenticationApplication = {
      id: `authapp_${randomUUID()}`,
      ownerPrincipalId: principalId,
      ...(parsed.data.organizationId
        ? { organizationId: parsed.data.organizationId }
        : undefined),
      displayName: parsed.data.displayName,
      rpId: parsed.data.rpId,
      origins: [...new Set(parsed.data.origins)],
      secretHash: minted.secretHash,
      secretPrefix: minted.secretPrefix,
      apiKeys: [
        {
          id: `authkey_${randomUUID()}`,
          secretHash: minted.secretHash,
          secretPrefix: minted.secretPrefix,
          state: "active",
          createdAt: now.toISOString(),
        },
      ],
      configurations: DEFAULT_AUTHENTICATION_CONFIGURATIONS.map(
        (configuration) => ({
          ...configuration,
          hints: [...configuration.hints],
        }),
      ),
      manualTokensEnabled: false,
      magicLinksEnabled: false,
      state: "active",
      createdAt: now,
      updatedAt: now,
    };
    await ctx.authenticationStores.applications.create(application);
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "authentication.application.created",
      outcome: "succeeded",
      principalId,
      clientId: application.id,
      ...(application.organizationId
        ? { organizationId: application.organizationId }
        : undefined),
      correlationId: c.get("correlationId"),
      metadata: { rpId: application.rpId },
    });
    return c.json(
      {
        application: applicationResponse(application),
        apiSecret: minted.secret,
      },
      201,
    );
  },
);

authenticationServiceRoutes.patch(
  "/applications/:applicationId",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const application = await managedApplication(
      ctx,
      c.req.param("applicationId"),
      principalId,
    );
    if (!application) return c.json({ error: "not_found" }, 404);
    const parsed = PatchAuthenticationApplicationRequestSchema.safeParse(
      await c.req.json(),
    );
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }
    const updated = await ctx.authenticationStores.applications.update({
      ...application,
      displayName: parsed.data.displayName ?? application.displayName,
      state: parsed.data.state ?? application.state,
      manualTokensEnabled:
        parsed.data.manualTokensEnabled ?? application.manualTokensEnabled,
      magicLinksEnabled:
        parsed.data.magicLinksEnabled ?? application.magicLinksEnabled,
      configurations: parsed.data.configurations ?? application.configurations,
      updatedAt: ctx.clock(),
    });
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "authentication.application.updated",
      outcome: "succeeded",
      principalId,
      clientId: application.id,
      ...(application.organizationId
        ? { organizationId: application.organizationId }
        : undefined),
      correlationId: c.get("correlationId"),
      metadata: { state: updated.state },
    });
    return c.json({ application: applicationResponse(updated) });
  },
);

authenticationServiceRoutes.post(
  "/applications/:applicationId/rotate-secret",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const application = await managedApplication(
      ctx,
      c.req.param("applicationId"),
      principalId,
    );
    if (!application) return c.json({ error: "not_found" }, 404);
    const minted = mintAuthenticationApplicationSecret();
    const updated = await ctx.authenticationStores.applications.update({
      ...application,
      secretHash: minted.secretHash,
      secretPrefix: minted.secretPrefix,
      apiKeys: [
        {
          id: `authkey_${randomUUID()}`,
          secretHash: minted.secretHash,
          secretPrefix: minted.secretPrefix,
          state: "active",
          createdAt: ctx.clock().toISOString(),
        },
      ],
      updatedAt: ctx.clock(),
    });
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "authentication.application.secret_rotated",
      outcome: "succeeded",
      principalId,
      clientId: application.id,
      ...(application.organizationId
        ? { organizationId: application.organizationId }
        : undefined),
      correlationId: c.get("correlationId"),
      metadata: {},
    });
    return c.json({
      application: applicationResponse(updated),
      apiSecret: minted.secret,
    });
  },
);

authenticationServiceRoutes.post(
  "/applications/:applicationId/api-keys",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const application = await managedApplication(
      ctx,
      c.req.param("applicationId"),
      principalId,
    );
    if (!application) return c.json({ error: "not_found" }, 404);
    const minted = mintAuthenticationApplicationSecret();
    const key = {
      id: `authkey_${randomUUID()}`,
      secretHash: minted.secretHash,
      secretPrefix: minted.secretPrefix,
      state: "active" as const,
      createdAt: ctx.clock().toISOString(),
    };
    const updated = await ctx.authenticationStores.applications.update({
      ...application,
      apiKeys: [...application.apiKeys, key],
      updatedAt: ctx.clock(),
    });
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "authentication.application.key_created",
      outcome: "succeeded",
      principalId,
      clientId: application.id,
      ...(application.organizationId
        ? { organizationId: application.organizationId }
        : undefined),
      correlationId: c.get("correlationId"),
      targetType: "authentication_api_key",
      targetId: key.id,
      metadata: {},
    });
    return c.json(
      {
        application: applicationResponse(updated),
        apiKey: { id: key.id, secret: minted.secret },
      },
      201,
    );
  },
);

authenticationServiceRoutes.patch(
  "/applications/:applicationId/api-keys/:keyId",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const application = await managedApplication(
      ctx,
      c.req.param("applicationId"),
      principalId,
    );
    if (!application) return c.json({ error: "not_found" }, 404);
    const parsed = PatchAuthenticationApiKeyRequestSchema.safeParse(
      await c.req.json(),
    );
    if (!parsed.success) return c.json({ error: "validation_error" }, 400);
    const keyId = c.req.param("keyId");
    if (!application.apiKeys.some((key) => key.id === keyId)) {
      return c.json({ error: "not_found" }, 404);
    }
    if (
      parsed.data.state === "locked" &&
      application.apiKeys.filter(
        (key) => key.state === "active" && key.id !== keyId,
      ).length === 0
    ) {
      return c.json({ error: "last_active_key" }, 409);
    }
    const updated = await ctx.authenticationStores.applications.update({
      ...application,
      apiKeys: application.apiKeys.map((key) =>
        key.id === keyId ? { ...key, state: parsed.data.state } : key,
      ),
      updatedAt: ctx.clock(),
    });
    return c.json({ application: applicationResponse(updated) });
  },
);

authenticationServiceRoutes.delete(
  "/applications/:applicationId/api-keys/:keyId",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const application = await managedApplication(
      ctx,
      c.req.param("applicationId"),
      principalId,
    );
    if (!application) return c.json({ error: "not_found" }, 404);
    const keyId = c.req.param("keyId");
    const key = application.apiKeys.find((candidate) => candidate.id === keyId);
    if (!key) return c.json({ error: "not_found" }, 404);
    if (key.state !== "locked") return c.json({ error: "lock_key_first" }, 409);
    const updated = await ctx.authenticationStores.applications.update({
      ...application,
      apiKeys: application.apiKeys.filter(
        (candidate) => candidate.id !== keyId,
      ),
      updatedAt: ctx.clock(),
    });
    return c.json({ application: applicationResponse(updated) });
  },
);

authenticationServiceRoutes.post("/backend/registration-tokens", async (c) => {
  const ctx = c.get("ctx");
  const parsed = CreateRegistrationTokenRequestSchema.safeParse(
    await c.req.json(),
  );
  if (!parsed.success) {
    return c.json(
      { error: "validation_error", details: parsed.error.flatten() },
      400,
    );
  }
  const application = await backendApplication(
    ctx,
    parsed.data.applicationId,
    c.req.header("authorization"),
  );
  const principalId = c.get("principalId");
  const managed = principalId
    ? await managedApplication(ctx, parsed.data.applicationId, principalId)
    : undefined;
  if (!application && !managed) {
    c.header("WWW-Authenticate", "Bearer");
    return c.json({ error: "unauthorized" }, 401);
  }
  try {
    const auditedApplication = application ?? managed;
    const result = await ctx.authentication.createRegistrationToken({
      applicationId: parsed.data.applicationId,
      userId: parsed.data.userId,
      userName: parsed.data.userName,
      displayName: parsed.data.displayName,
      aliases: parsed.data.aliases,
      aliasHashing: parsed.data.aliasHashing,
      userVerification: parsed.data.userVerification,
      ...(parsed.data.authenticatorAttachment
        ? { authenticatorAttachment: parsed.data.authenticatorAttachment }
        : undefined),
    });
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "authentication.registration_token.created",
      outcome: "succeeded",
      ...(principalId ? { principalId } : undefined),
      clientId: parsed.data.applicationId,
      ...(auditedApplication?.organizationId
        ? { organizationId: auditedApplication.organizationId }
        : undefined),
      correlationId: c.get("correlationId"),
      targetType: "authentication_user",
      targetId: parsed.data.userId,
      metadata: {},
    });
    return c.json(
      { token: result.token, expiresAt: result.expiresAt.toISOString() },
      201,
    );
  } catch (error) {
    if (!(error instanceof AuthenticationServiceError)) throw error;
    return serviceError(error);
  }
});

authenticationServiceRoutes.post(
  "/backend/signin/generate-token",
  async (c) => {
    const ctx = c.get("ctx");
    const parsed = GenerateAuthenticationTokenRequestSchema.safeParse(
      await c.req.json(),
    );
    if (!parsed.success) return c.json({ error: "validation_error" }, 400);
    const application = await backendApplication(
      ctx,
      parsed.data.applicationId,
      c.req.header("authorization"),
    );
    if (!application) return c.json({ error: "unauthorized" }, 401);
    try {
      const result = await ctx.authentication.generateToken({
        applicationId: parsed.data.applicationId,
        userId: parsed.data.userId,
        purpose: parsed.data.purpose,
        ...(parsed.data.timeToLiveSeconds
          ? { timeToLiveSeconds: parsed.data.timeToLiveSeconds }
          : undefined),
      });
      return c.json(
        { token: result.token, expiresAt: result.expiresAt.toISOString() },
        201,
      );
    } catch (error) {
      if (!(error instanceof AuthenticationServiceError)) throw error;
      return serviceError(error);
    }
  },
);

authenticationServiceRoutes.post("/backend/aliases", async (c) => {
  const ctx = c.get("ctx");
  const parsed = SetAuthenticationAliasesRequestSchema.safeParse(
    await c.req.json(),
  );
  if (!parsed.success) return c.json({ error: "validation_error" }, 400);
  const application = await backendApplication(
    ctx,
    parsed.data.applicationId,
    c.req.header("authorization"),
  );
  if (!application) return c.json({ error: "unauthorized" }, 401);
  try {
    await ctx.authentication.setAliases(parsed.data);
    return c.body(null, 204);
  } catch (error) {
    if (!(error instanceof AuthenticationServiceError)) throw error;
    return serviceError(error);
  }
});

authenticationServiceRoutes.post("/backend/credentials/list", async (c) => {
  const ctx = c.get("ctx");
  const parsed = AuthenticationCredentialsRequestSchema.safeParse(
    await c.req.json(),
  );
  if (!parsed.success) return c.json({ error: "validation_error" }, 400);
  const application = await backendApplication(
    ctx,
    parsed.data.applicationId,
    c.req.header("authorization"),
  );
  if (!application) return c.json({ error: "unauthorized" }, 401);
  try {
    const credentials = await ctx.authentication.listCredentials(
      application.id,
      parsed.data.userId,
    );
    return c.json({
      credentials: credentials.map((credential) => ({
        credentialId: credential.credentialId,
        userId: credential.userId,
        signatureCounter: credential.counter,
        transports: credential.transports,
        nickname: credential.name ?? null,
        createdAt: credential.createdAt.toISOString(),
        lastUsedAt: credential.lastUsedAt?.toISOString() ?? null,
        rpId: application.rpId,
      })),
    });
  } catch (error) {
    if (!(error instanceof AuthenticationServiceError)) throw error;
    return serviceError(error);
  }
});

authenticationServiceRoutes.post("/backend/credentials/delete", async (c) => {
  const ctx = c.get("ctx");
  const parsed = DeleteAuthenticationCredentialRequestSchema.safeParse(
    await c.req.json(),
  );
  if (!parsed.success) return c.json({ error: "validation_error" }, 400);
  const application = await backendApplication(
    ctx,
    parsed.data.applicationId,
    c.req.header("authorization"),
  );
  if (!application) return c.json({ error: "unauthorized" }, 401);
  const removed = await ctx.authenticationStores.credentials.remove(
    application.id,
    parsed.data.credentialId,
  );
  return removed ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
});

authenticationServiceRoutes.post("/backend/magic-links/send", async (c) => {
  const ctx = c.get("ctx");
  const parsed = SendAuthenticationMagicLinkRequestSchema.safeParse(
    await c.req.json(),
  );
  if (!parsed.success) return c.json({ error: "validation_error" }, 400);
  const application = await backendApplication(
    ctx,
    parsed.data.applicationId,
    c.req.header("authorization"),
  );
  if (!application) return c.json({ error: "unauthorized" }, 401);
  const template = parsed.data.urlTemplate.replace("$TOKEN", "placeholder");
  if (!application.origins.includes(new URL(template).origin)) {
    return c.json({ error: "origin_not_allowed" }, 403);
  }
  try {
    const result = await ctx.authentication.generateToken({
      applicationId: application.id,
      userId: parsed.data.userId,
      purpose: parsed.data.purpose,
      timeToLiveSeconds: parsed.data.timeToLiveSeconds,
      type: "magic_link",
    });
    const link = parsed.data.urlTemplate.replace(
      "$TOKEN",
      encodeURIComponent(result.token),
    );
    await ctx.mailer.send({
      to: parsed.data.emailAddress,
      subject: `Sign in to ${application.displayName}`,
      text: `Sign in to ${application.displayName}: ${link}\n\nThis link expires at ${result.expiresAt.toISOString()}.`,
    });
    return c.body(null, 204);
  } catch (error) {
    if (error instanceof AuthenticationServiceError) return serviceError(error);
    ctx.log.error(
      { err: error },
      "authentication service magic link delivery failed",
    );
    return c.json({ error: "mail_delivery_failed" }, 503);
  }
});

authenticationServiceRoutes.get("/backend/auth-configurations", async (c) => {
  const ctx = c.get("ctx");
  const applicationId = c.req.query("applicationId") ?? "";
  const application = await backendApplication(
    ctx,
    applicationId,
    c.req.header("authorization"),
  );
  if (!application) return c.json({ error: "unauthorized" }, 401);
  const purpose = c.req.query("purpose");
  return c.json({
    configurations: purpose
      ? application.configurations.filter(
          (configuration) => configuration.purpose === purpose,
        )
      : application.configurations,
  });
});

authenticationServiceRoutes.post("/backend/auth-configurations", async (c) => {
  const ctx = c.get("ctx");
  const parsed = AuthenticationConfigurationRequestSchema.safeParse(
    await c.req.json(),
  );
  if (!parsed.success) return c.json({ error: "validation_error" }, 400);
  const application = await backendApplication(
    ctx,
    parsed.data.applicationId,
    c.req.header("authorization"),
  );
  if (!application) return c.json({ error: "unauthorized" }, 401);
  if (
    application.configurations.some(
      (configuration) => configuration.purpose === parsed.data.purpose,
    )
  ) {
    return c.json({ error: "configuration_exists" }, 409);
  }
  const updated = await ctx.authenticationStores.applications.update({
    ...application,
    configurations: [...application.configurations, parsed.data],
    updatedAt: ctx.clock(),
  });
  return c.json({ application: applicationResponse(updated) }, 201);
});

authenticationServiceRoutes.patch(
  "/backend/auth-configurations/:purpose",
  async (c) => {
    const ctx = c.get("ctx");
    const parsed = AuthenticationConfigurationRequestSchema.safeParse({
      ...(await c.req.json()),
      purpose: c.req.param("purpose"),
    });
    if (!parsed.success) return c.json({ error: "validation_error" }, 400);
    const application = await backendApplication(
      ctx,
      parsed.data.applicationId,
      c.req.header("authorization"),
    );
    if (!application) return c.json({ error: "unauthorized" }, 401);
    if (
      !application.configurations.some(
        (item) => item.purpose === parsed.data.purpose,
      )
    ) {
      return c.json({ error: "not_found" }, 404);
    }
    await ctx.authenticationStores.applications.update({
      ...application,
      configurations: application.configurations.map((item) =>
        item.purpose === parsed.data.purpose ? parsed.data : item,
      ),
      updatedAt: ctx.clock(),
    });
    return c.body(null, 204);
  },
);

authenticationServiceRoutes.delete(
  "/backend/auth-configurations/:purpose",
  async (c) => {
    const ctx = c.get("ctx");
    const parsed =
      AuthenticationConfigurationApplicationRequestSchema.safeParse(
        await c.req.json(),
      );
    if (!parsed.success) return c.json({ error: "validation_error" }, 400);
    const application = await backendApplication(
      ctx,
      parsed.data.applicationId,
      c.req.header("authorization"),
    );
    if (!application) return c.json({ error: "unauthorized" }, 401);
    const purpose = c.req.param("purpose");
    if (purpose === "sign-in" || purpose === "step-up") {
      return c.json({ error: "built_in_configuration" }, 409);
    }
    if (!application.configurations.some((item) => item.purpose === purpose)) {
      return c.json({ error: "not_found" }, 404);
    }
    await ctx.authenticationStores.applications.update({
      ...application,
      configurations: application.configurations.filter(
        (item) => item.purpose !== purpose,
      ),
      updatedAt: ctx.clock(),
    });
    return c.body(null, 204);
  },
);

authenticationServiceRoutes.post("/public/register/options", async (c) => {
  if (!consumePublicBudget(c)) return c.json({ error: "rate_limited" }, 429);
  const parsed = AuthenticationRegistrationOptionsRequestSchema.safeParse(
    await c.req.json(),
  );
  if (!parsed.success) return c.json({ error: "validation_error" }, 400);
  const origin = c.req.header("origin");
  if (!origin) return c.json({ error: "origin_required" }, 400);
  try {
    return c.json(
      await c
        .get("ctx")
        .authentication.registrationOptions({ ...parsed.data, origin }),
    );
  } catch (error) {
    if (!(error instanceof AuthenticationServiceError)) throw error;
    return serviceError(error);
  }
});

authenticationServiceRoutes.post("/public/register/verify", async (c) => {
  if (!consumePublicBudget(c)) return c.json({ error: "rate_limited" }, 429);
  const parsed = AuthenticationRegistrationVerifyRequestSchema.safeParse(
    await c.req.json(),
  );
  if (!parsed.success) return c.json({ error: "validation_error" }, 400);
  const ctx = c.get("ctx");
  try {
    const result = await ctx.authentication.verifyRegistration({
      applicationId: parsed.data.applicationId,
      response: overlapCast(parsed.data.response),
      ...(parsed.data.name ? { name: parsed.data.name } : undefined),
    });
    const application = await ctx.authenticationStores.applications.get(
      parsed.data.applicationId,
    );
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "authentication.credential.registered",
      outcome: "succeeded",
      clientId: parsed.data.applicationId,
      ...(application?.organizationId
        ? { organizationId: application.organizationId }
        : undefined),
      correlationId: c.get("correlationId"),
      targetType: "authentication_user",
      targetId: result.userId,
      metadata: { credentialId: result.credentialId },
    });
    return c.json({ ok: true, ...result }, 201);
  } catch (error) {
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "authentication.credential.registration_failed",
      outcome: "failed",
      clientId: parsed.data.applicationId,
      correlationId: c.get("correlationId"),
      metadata: {
        reason:
          error instanceof AuthenticationServiceError
            ? error.code
            : "internal_error",
      },
    });
    if (!(error instanceof AuthenticationServiceError)) throw error;
    return serviceError(error);
  }
});

authenticationServiceRoutes.post("/public/signin/options", async (c) => {
  if (!consumePublicBudget(c)) return c.json({ error: "rate_limited" }, 429);
  const parsed = AuthenticationOptionsRequestSchema.safeParse(
    await c.req.json(),
  );
  if (!parsed.success) return c.json({ error: "validation_error" }, 400);
  const origin = c.req.header("origin");
  if (!origin) return c.json({ error: "origin_required" }, 400);
  try {
    return c.json(
      await c.get("ctx").authentication.authenticationOptions({
        applicationId: parsed.data.applicationId,
        mode: parsed.data.mode,
        origin,
        ...(parsed.data.alias ? { alias: parsed.data.alias } : undefined),
        ...(parsed.data.userId ? { userId: parsed.data.userId } : undefined),
        purpose: parsed.data.purpose,
      }),
    );
  } catch (error) {
    if (!(error instanceof AuthenticationServiceError)) throw error;
    return serviceError(error);
  }
});

authenticationServiceRoutes.post("/public/signin/verify", async (c) => {
  if (!consumePublicBudget(c)) return c.json({ error: "rate_limited" }, 429);
  const parsed = AuthenticationVerifyRequestSchema.safeParse(
    await c.req.json(),
  );
  if (!parsed.success) return c.json({ error: "validation_error" }, 400);
  const ctx = c.get("ctx");
  try {
    const result = await ctx.authentication.verifyAuthentication({
      applicationId: parsed.data.applicationId,
      response: overlapCast(parsed.data.response),
    });
    const application = await ctx.authenticationStores.applications.get(
      parsed.data.applicationId,
    );
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "authentication.signin.succeeded",
      outcome: "succeeded",
      clientId: parsed.data.applicationId,
      ...(application?.organizationId
        ? { organizationId: application.organizationId }
        : undefined),
      correlationId: c.get("correlationId"),
      metadata: {},
    });
    return c.json({
      token: result.token,
      expiresAt: result.expiresAt.toISOString(),
    });
  } catch (error) {
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "authentication.signin.failed",
      outcome: "failed",
      clientId: parsed.data.applicationId,
      correlationId: c.get("correlationId"),
      metadata: {
        reason:
          error instanceof AuthenticationServiceError
            ? error.code
            : "internal_error",
      },
    });
    if (!(error instanceof AuthenticationServiceError)) throw error;
    return serviceError(error);
  }
});

authenticationServiceRoutes.post("/backend/signin/verify-token", async (c) => {
  const ctx = c.get("ctx");
  const parsed = AuthenticationTokenVerifyRequestSchema.safeParse(
    await c.req.json(),
  );
  if (!parsed.success) return c.json({ error: "validation_error" }, 400);
  const application = await backendApplication(
    ctx,
    parsed.data.applicationId,
    c.req.header("authorization"),
  );
  if (!application) {
    c.header("WWW-Authenticate", "Bearer");
    return c.json({ error: "unauthorized" }, 401);
  }
  try {
    return c.json(
      await ctx.authentication.verifyToken(
        parsed.data.applicationId,
        parsed.data.token,
      ),
    );
  } catch (error) {
    if (!(error instanceof AuthenticationServiceError)) throw error;
    return serviceError(error);
  }
});

authenticationServiceRoutes.get(
  "/applications/:applicationId/users",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const application = await managedApplication(
      ctx,
      c.req.param("applicationId"),
      principalId,
    );
    if (!application) return c.json({ error: "not_found" }, 404);
    const users = await ctx.authenticationStores.users.list(application.id);
    return c.json({
      users: await Promise.all(
        users.map(async (user) => ({
          ...user,
          createdAt: user.createdAt.toISOString(),
          updatedAt: user.updatedAt.toISOString(),
          aliases: (
            await ctx.authenticationStores.users.aliases(
              application.id,
              user.userId,
            )
          ).flatMap((alias) => {
            const visible = visibleAuthenticationAlias(alias);
            return visible ? [visible] : [];
          }),
          credentials: (
            await ctx.authenticationStores.credentials.listByUser(
              application.id,
              user.userId,
            )
          ).map((credential) => ({
            credentialId: credential.credentialId,
            name: credential.name ?? null,
            transports: credential.transports,
            createdAt: credential.createdAt.toISOString(),
            lastUsedAt: credential.lastUsedAt?.toISOString() ?? null,
          })),
        })),
      ),
    });
  },
);

authenticationServiceRoutes.patch(
  "/applications/:applicationId/credentials/:credentialId",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const application = await managedApplication(
      ctx,
      c.req.param("applicationId"),
      principalId,
    );
    if (!application) return c.json({ error: "not_found" }, 404);
    const parsed = RenameAuthenticationCredentialRequestSchema.safeParse(
      await c.req.json(),
    );
    if (!parsed.success) return c.json({ error: "validation_error" }, 400);
    const updated = await ctx.authenticationStores.credentials.rename(
      application.id,
      c.req.param("credentialId"),
      parsed.data.name ?? undefined,
      ctx.clock(),
    );
    return updated ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
  },
);

authenticationServiceRoutes.delete(
  "/applications/:applicationId/credentials/:credentialId",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const application = await managedApplication(
      ctx,
      c.req.param("applicationId"),
      principalId,
    );
    if (!application) return c.json({ error: "not_found" }, 404);
    const removed = await ctx.authenticationStores.credentials.remove(
      application.id,
      c.req.param("credentialId"),
    );
    if (!removed) return c.json({ error: "not_found" }, 404);
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "authentication.credential.revoked",
      outcome: "succeeded",
      principalId,
      clientId: application.id,
      ...(application.organizationId
        ? { organizationId: application.organizationId }
        : undefined),
      correlationId: c.get("correlationId"),
      metadata: {},
    });
    return c.json({ ok: true });
  },
);

authenticationServiceRoutes.get(
  "/applications/:applicationId/events",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const application = await managedApplication(
      ctx,
      c.req.param("applicationId"),
      principalId,
    );
    if (!application) return c.json({ error: "not_found" }, 404);
    const events = await ctx.repos.auditEvents.list({
      clientId: application.id,
      limit: 200,
    });
    return c.json({
      events: events.map((event) => ({
        id: event.id,
        occurredAt: event.occurredAt.toISOString(),
        eventType: event.eventType,
        outcome: event.outcome,
        correlationId: event.correlationId,
        metadata: redactAuditMetadata(event.metadata),
      })),
    });
  },
);

authenticationServiceRoutes.get(
  "/organizations/:organizationId/events",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    if (
      !(await assertOrganizationAdmin(
        ctx,
        c.req.param("organizationId"),
        principalId,
      ))
    ) {
      return c.json({ error: "not_found" }, 404);
    }
    const events = await ctx.repos.auditEvents.list({
      organizationId: c.req.param("organizationId"),
      limit: 200,
    });
    return c.json({
      events: events.map((event) => ({
        id: event.id,
        occurredAt: event.occurredAt.toISOString(),
        eventType: event.eventType,
        outcome: event.outcome,
        correlationId: event.correlationId,
        clientId: event.clientId ?? null,
        metadata: redactAuditMetadata(event.metadata),
      })),
    });
  },
);
