import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpBindings } from "@hono/node-server";
import type { OpenSesameProviderBundle } from "@opensesame/oauth-provider";
import { isString, overlapCast } from "@opensesame/os-domain";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import type { InteractionCsrf } from "../interactions/csrf.js";
import {
  type LoginPageOptions,
  buildLoginPageModel,
  finishLoginInteraction,
} from "../interactions/handlers.js";
import type {
  InteractionDetails,
  ProviderInteractions,
} from "../interactions/types.js";
import type { Variables } from "../middleware/context.js";
import {
  BetterAuthBridgeError,
  type BridgedSession,
  MAGIC_LINK_INTERACTION_KEY,
  normalizeEmail,
  principalForBetterAuthSubject,
  requestMagicLink,
  verifyMagicLinkToken,
} from "../services/better-auth-bridge.js";
import { renderLoginPage } from "../ui/interaction-pages.js";

type NodeEnv = { Bindings: HttpBindings };

/**
 * "Continue with email" on the hosted login page (C22 / D18).
 *
 * Two routes and one token between them. The POST asks Better Auth for a
 * single-use link and re-renders the page saying to go read the inbox; the GET
 * is where that link lands, and it is a top-level same-site navigation, so it
 * carries the `SameSite=Lax` interaction cookie the POST's own response could
 * not have carried anywhere. That is the same completion-code shape the SAML
 * ACS uses (C14), with one difference worth naming: there is no second code to
 * mint, because the magic-link token already *is* a single-use completion code
 * — Better Auth consumes it atomically inside the verification.
 *
 * The address here is an identifier and is meant to be. That is the opposite of
 * the work-email field two panels up, which routes on the domain and discards
 * the rest (D12/T28); the distinction is deliberate and both rules hold at once.
 */

/** Enough for any deliverable address (RFC 5321 caps the path at 256 octets). */
const MAX_EMAIL_LENGTH = 254;
const MAX_TOKEN_LENGTH = 512;

/** Bridge failures that mean "the deployment is busy", not "no". */
const MINT_REFUSALS = new Set(["rate_limited", "provisional_capacity"]);

/**
 * Deliberately permissive: this is a length-and-shape sanity check, not an
 * attempt to out-parse RFC 5322. Whether an address exists is answered by
 * whether a link arrives, which is the only test that means anything.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

const INVALID_EMAIL_MESSAGE = "Enter an email address to receive a link.";
const UNDELIVERABLE_MESSAGE =
  "That link could not be sent right now. Try another sign-in method.";
const EXPIRED_LINK_MESSAGE =
  "That sign-in link has expired or was already used. Request a new one.";

/**
 * Per-address budget for outbound links.
 *
 * The login page is unauthenticated and this route makes it send mail, which
 * makes it an amplifier pointed at whatever address the poster types. Counted
 * per address rather than per client so the fence protects the person being
 * mailed rather than the person doing the mailing: five links to one inbox in
 * ten minutes is already generous, and no number of distinct submitters raises
 * it. The key is a hash — the address itself is never a map key, a log line, or
 * an audit field.
 */
const EMAIL_BUDGET_WINDOW_MS = 10 * 60 * 1000;
const EMAIL_BUDGET_MAX = 5;
const emailBudget = new Map<string, number[]>();

/** Test hook: drop every recorded send window. */
export function resetEmailLinkBudget(): void {
  emailBudget.clear();
}

function consumeEmailBudget(key: string, now: number): boolean {
  const recent = (emailBudget.get(key) ?? []).filter(
    (at) => now - at < EMAIL_BUDGET_WINDOW_MS,
  );
  if (recent.length >= EMAIL_BUDGET_MAX) {
    emailBudget.set(key, recent);
    return false;
  }
  recent.push(now);
  emailBudget.set(key, recent);
  return true;
}

function providerInteractions(
  provider: OpenSesameProviderBundle["provider"],
): ProviderInteractions {
  // SAFETY: panva's Provider implements interactionDetails/interactionResult;
  // the Client generic is unused at this boundary.
  return overlapCast(provider);
}

export function createEmailInteractionRoutes(
  csrf: InteractionCsrf,
): Hono<{ Variables: Variables } & NodeEnv> {
  const routes = new Hono<{ Variables: Variables } & NodeEnv>();

  // Deliberately local rather than shared with `interactions.ts`: C9 keeps the
  // sub-router files disjoint, and the helper is four lines.
  async function loadDetails(
    c: { env: HttpBindings },
    provider: ProviderInteractions,
  ): Promise<
    | {
        http: { req: IncomingMessage; res: ServerResponse };
        details: InteractionDetails;
      }
    | { error: string; status: 404 | 501 }
  > {
    const req = c.env?.incoming;
    const res = c.env?.outgoing;
    if (!req || !res) {
      return {
        error: "OIDC interactions require the Node HTTP adapter",
        status: 501,
      };
    }
    try {
      return {
        http: { req, res },
        details: await provider.interactionDetails(req, res),
      };
    } catch {
      return { error: "Interaction not found or expired", status: 404 };
    }
  }

  routes.post("/:uid/federated/email", async (c) => {
    const ctx = c.get("ctx");
    const provider = providerInteractions(ctx.oauth.provider);
    const uid = c.req.param("uid");
    const fields = overlapCast(await c.req.parseBody());
    if (!csrf.verify(uid, isString(fields._csrf) ? fields._csrf : undefined)) {
      return c.text("Invalid or expired CSRF token", 403);
    }
    const loaded = await loadDetails(c, provider);
    if ("error" in loaded) {
      return c.text(loaded.error, loaded.status);
    }
    const { details } = loaded;
    if (details.prompt.name !== "login") {
      return c.text("Prompt mismatch", 400);
    }

    // Every branch below re-renders, and `csrf.verify` above spent the token
    // this form carried, so each one issues a fresh one (T13).
    const rerender = async (options: LoginPageOptions) =>
      c.html(
        renderLoginPage(
          await buildLoginPageModel(
            ctx,
            details,
            csrf.issue(details.uid),
            c.get("principalId"),
            options,
          ),
        ),
      );

    const raw = isString(fields.email) ? fields.email : "";
    const email = normalizeEmail(raw);
    if (
      !email ||
      email.length > MAX_EMAIL_LENGTH ||
      !EMAIL_PATTERN.test(email)
    ) {
      return rerender({ emailError: INVALID_EMAIL_MESSAGE });
    }

    // Budget exhaustion answers exactly like a successful send. Saying "too
    // many links have been sent to that address" would confirm the address is
    // one somebody signs in with.
    const budgetKey = createHash("sha256").update(email).digest("hex");
    if (!consumeEmailBudget(budgetKey, ctx.clock().getTime())) {
      return rerender({ emailSent: true });
    }

    try {
      await requestMagicLink(ctx, email, {
        [MAGIC_LINK_INTERACTION_KEY]: uid,
      });
    } catch (error) {
      // A transport that is missing or refusing is an operator problem, and the
      // person in front of the page needs to be told to try something else
      // rather than to keep waiting for mail that cannot arrive.
      ctx.log.error({ err: error }, "magic link delivery failed");
      return rerender({ emailError: UNDELIVERABLE_MESSAGE });
    }
    // The same page for an address this deployment knows and one it has never
    // seen: the request itself must not answer whether an account exists.
    return rerender({ emailSent: true });
  });

  /**
   * Where the emailed link lands. A top-level GET, so the interaction cookie is
   * present; no CSRF token, because the single-use token in the query IS the
   * credential and consuming it is what proves control of the inbox.
   */
  routes.get("/:uid/federated/email/verify", async (c) => {
    const ctx = c.get("ctx");
    const provider = providerInteractions(ctx.oauth.provider);
    const loaded = await loadDetails(c, provider);
    if ("error" in loaded) {
      return c.text(loaded.error, loaded.status);
    }
    const { http, details } = loaded;
    if (details.prompt.name !== "login") {
      return c.text("Prompt mismatch", 400);
    }

    const token = c.req.query("token") ?? "";
    const subject =
      token && token.length <= MAX_TOKEN_LENGTH
        ? await verifyMagicLinkToken(ctx, token)
        : undefined;
    if (!subject) {
      return c.html(
        renderLoginPage(
          await buildLoginPageModel(
            ctx,
            details,
            csrf.issue(details.uid),
            c.get("principalId"),
            { emailError: EXPIRED_LINK_MESSAGE },
          ),
        ),
        400,
      );
    }

    let session: BridgedSession;
    try {
      session = await principalForBetterAuthSubject(
        ctx,
        subject,
        c.get("correlationId"),
      );
    } catch (error) {
      if (error instanceof BetterAuthBridgeError) {
        // Both provisional-mint refusals are "come back later" (429); a
        // collision or an inactive principal is a refusal of this sign-in (403).
        return c.text(error.message, MINT_REFUSALS.has(error.code) ? 429 : 403);
      }
      throw error;
    }

    // The browser holding this cookie is the one that just proved control of
    // the address, whether the principal is new or returning — unlike the
    // redirect legs, where a returning identity gets no new cookie (T6),
    // because there the browser proved nothing.
    setCookie(c, ctx.config.provisionalCookieName, session.accessToken, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: Math.floor(ctx.config.provisionalTtlMs / 1000),
      secure: ctx.config.publicUrl.startsWith("https://"),
    });

    const returnTo = await finishLoginInteraction(
      provider,
      http.req,
      http.res,
      session.principalId,
    );
    return c.redirect(returnTo, 303);
  });

  return routes;
}
