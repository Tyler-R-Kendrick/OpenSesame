/**
 * The launcher-registration HTTP surface (ADR 0086), mounted by the app wiring.
 *
 * A launcher pass is the persistent card a person keeps that opens OpenSesame,
 * as opposed to the per-interaction "address" pass fronted by
 * `interaction-handoff.ts`. This router is deliberately thin: every lifecycle
 * rule that matters — idempotent, owned registration; the seed that never
 * reaches a Save link; disablement that is local first and independent of
 * Google — lives in `services/wallet-registration.ts`, so a handler here only
 * authenticates, validates, and renders.
 *
 * It is exported as a mount helper rather than wired here, because the provider
 * and store are constructed once at startup from configuration this file does
 * not own. The app wiring calls `createWalletRegistrationRoutes` with a
 * configured `WalletLauncherProvider` and a durable `WalletRegistrationStore`
 * and mounts the result under `/v1/wallet/registrations`.
 */

import { appendAuditEvent } from "@opensesame/audit";
import {
  WalletLauncherError,
  type WalletLauncherProvider,
  WalletNotConfiguredError,
  WalletPayloadRejected,
  type WalletRegistration,
  type WalletRegistrationStore,
  WalletRequestError,
} from "@opensesame/wallet";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import {
  WalletRegistrationRefused,
  type WalletRegistrationService,
  createWalletRegistrationService,
} from "../services/wallet-registration.js";
import { authenticatedPrincipalId } from "./organizations.js";

/**
 * What the app wiring supplies. A configured provider and a durable store; the
 * service that binds them is built here so a caller cannot forget to.
 */
export interface WalletRegistrationMount {
  provider: WalletLauncherProvider;
  store: WalletRegistrationStore;
}

const RegisterSchema = z.object({
  // Caller-chosen id for this device registration. The wallet builder enforces
  // the URL/object-id charset; this is the coarse length bound.
  registrationId: z.string().min(1).max(128),
  header: z.string().min(1).max(120),
  subtitle: z.string().min(1).max(120).optional(),
  rotatingBarcode: z.boolean().optional(),
});

/** The registration as a client sees it. `passId` is derived and not secret. */
function toWire(registration: WalletRegistration) {
  return {
    registrationId: registration.registrationId,
    state: registration.state,
    passId: registration.passId,
    createdAt: registration.createdAt.toISOString(),
    ...(registration.disabledAt
      ? { disabledAt: registration.disabledAt.toISOString() }
      : undefined),
  };
}

function invalid(c: Context<{ Variables: Variables }>) {
  return c.json({ error: "invalid_request" }, 400);
}

export function createWalletRegistrationRoutes(
  deps: WalletRegistrationMount,
): Hono<{ Variables: Variables }> {
  const service: WalletRegistrationService = createWalletRegistrationService({
    provider: deps.provider,
    store: deps.store,
  });
  const routes = new Hono<{ Variables: Variables }>();

  /**
   * Register a persistent launcher for the calling principal.
   *
   * Idempotent for the same id and owner; the response says whether the link
   * was re-issued and whether a rotating barcode was actually provisioned
   * (which needs a reachable vendor and is honestly reported, never assumed).
   */
  routes.post("/", requirePrincipal(), async (c) => {
    const ctx = c.get("ctx");
    const ownerPrincipalId = authenticatedPrincipalId(c.get("principalId"));
    const parsed = RegisterSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) return invalid(c);
    const body = parsed.data;

    try {
      const result = await service.register({
        ownerPrincipalId,
        registrationId: body.registrationId,
        header: body.header,
        ...(body.subtitle !== undefined
          ? { subtitle: body.subtitle }
          : undefined),
        ...(body.rotatingBarcode !== undefined
          ? { rotatingBarcode: body.rotatingBarcode }
          : undefined),
      });
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "wallet.launcher.registered",
        principalId: ownerPrincipalId,
        actorType: "human",
        outcome: "succeeded",
        correlationId: c.get("correlationId"),
        metadata: {
          registrationId: result.registration.registrationId,
          reissued: result.reissued,
          rotatingBarcodeProvisioned: result.rotatingBarcodeProvisioned,
        },
      });
      return c.json(
        {
          ...toWire(result.registration),
          saveUrl: result.saveUrl,
          reissued: result.reissued,
          rotatingBarcodeProvisioned: result.rotatingBarcodeProvisioned,
        },
        result.reissued ? 200 : 201,
      );
    } catch (error) {
      if (error instanceof Error) {
        const mapped = mapRegisterError(c, error);
        if (mapped) return mapped;
      }
      throw error;
    }
  });

  /** The calling principal's launchers. Metadata only; no save links. */
  routes.get("/", requirePrincipal(), async (c) => {
    const ownerPrincipalId = authenticatedPrincipalId(c.get("principalId"));
    const registrations = await service.list(ownerPrincipalId);
    return c.json({ registrations: registrations.map(toWire) });
  });

  /**
   * Turn a launcher off.
   *
   * Local first: the record is disabled before Google is consulted, so this
   * succeeds even when the vendor is unreachable. `googleAcknowledged` reports
   * the best-effort vendor expiry and is informational — `false` never means
   * the launcher is still live.
   */
  routes.post("/:registrationId/disable", requirePrincipal(), async (c) => {
    const ctx = c.get("ctx");
    const ownerPrincipalId = authenticatedPrincipalId(c.get("principalId"));
    const registrationId = c.req.param("registrationId") ?? "";

    const outcome = await service.disable(ownerPrincipalId, registrationId);
    if (!outcome.registration) {
      return c.json({ error: "registration_not_found" }, 404);
    }
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "wallet.launcher.disabled",
      principalId: ownerPrincipalId,
      actorType: "human",
      outcome: "succeeded",
      correlationId: c.get("correlationId"),
      metadata: {
        registrationId: outcome.registration.registrationId,
        googleAcknowledged: outcome.googleAcknowledged,
      },
    });
    return c.json({
      ...toWire(outcome.registration),
      googleAcknowledged: outcome.googleAcknowledged,
    });
  });

  return routes;
}

/**
 * Map a registration failure onto the wire, without leaking a refused value.
 *
 * Returns `undefined` for an error this route does not own, so the caller
 * re-throws it to the app's error handler. A `WalletPayloadRejected` names a
 * rule and a path and never a value, but the caller gets only the code either
 * way: the detail belongs in the log, not in a response a requester reads back.
 */
function mapRegisterError(
  c: Context<{ Variables: Variables }>,
  error: Error,
): Response | undefined {
  if (error instanceof WalletNotConfiguredError) {
    // Running without a wallet is a supported configuration, not a fault.
    return c.json({ error: "wallet_not_configured" }, 409);
  }
  if (error instanceof WalletRegistrationRefused) {
    if (error.reason === "already_disabled") {
      return c.json({ error: "registration_disabled" }, 409);
    }
    // `owned_by_another` is invisible: a caller cannot learn an id they do not
    // own exists.
    return c.json({ error: "registration_not_found" }, 404);
  }
  if (
    error instanceof WalletLauncherError ||
    error instanceof WalletPayloadRejected
  ) {
    return c.json({ error: "invalid_request" }, 400);
  }
  if (error instanceof WalletRequestError) {
    // Provisioning reached Google and Google refused or was unreachable. The
    // launcher link itself was signed offline and is valid; report the vendor
    // trouble without pretending nothing happened.
    return c.json({ error: "wallet_provider_unavailable" }, 502);
  }
  return undefined;
}
