import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import {
  UnsafeMetadataUrlError,
  assertSafeMetadataUrl,
} from "@opensesame/oauth-provider";
import {
  type ByoUpstream,
  type ByoUpstreamClientAuth,
  type ByoUpstreamRegistrationSource,
  type JsonObject,
  isJsonObject,
  overlapCast,
  readString,
} from "@opensesame/os-domain";
import * as client from "openid-client";
import type { AppContext } from "../context.js";
import { normalizeIssuer } from "./registry.js";

/**
 * Bring your own identity provider (D5, ADR 0055).
 *
 * A first-time visitor with no account types their own issuer — their
 * Keycloak, their Authentik, their employer's IdP — into the hosted login
 * page, and this module turns that string into a durable upstream record the
 * trust fence (`./trust.ts`, C2) will admit. Everything after that is the
 * ordinary server-side OIDC leg: `beginFederatedAuth` resolves the record,
 * authenticates as the client it names, and the callback admits the subject.
 *
 * Three things make this different from every other issuer the leg talks to,
 * and each one is a fence here rather than a rule someone remembers:
 *
 * 1. **The issuer is attacker-controlled input.** It arrives in an
 *    unauthenticated form field and this server then dereferences it, which is
 *    the classic SSRF shape. Both the issuer and the `registration_endpoint`
 *    its discovery document names pass `assertSafeMetadataUrl` — the same
 *    guard the OAuth provider uses for remote client metadata (T21, reused
 *    rather than reinvented) — and https is mandatory outside a dev stack.
 * 2. **Registration is unauthenticated work.** Discovery is a network fetch
 *    somebody else's browser can ask for, so a per-fingerprint budget sits in
 *    front of it (five in ten minutes), independent of and ahead of the
 *    provisional-mint budget.
 * 3. **The record is durable and reused by issuer.** A returning visitor
 *    re-enters the same URL and gets the same record, and the answer is
 *    byte-identical whether or not the record already existed: telling a
 *    stranger which issuers this deployment has seen is an enumeration oracle.
 *    Durability is only half of re-entry: the redirect_uri a record's IdP
 *    matches is registered once and matched exactly afterwards, so every leg
 *    returns to the deployment-wide `stableFederatedRedirectUri`, never to the
 *    interaction that happened to register it (ADR 0055). That holds whether
 *    RFC 7591 registered the client or the visitor brought their own
 *    credentials — a visitor registering by hand is shown that same URL on the
 *    form, because it is the only one this deployment will ever redirect to.
 *
 * The client secret — supplied by the visitor or minted by RFC 7591 — is held
 * verbatim, because it must be presented to the token endpoint as issued and a
 * digest could never be. It is never logged, never audited, and never returned
 * on any agent-facing surface (ADR 0005; the admin list in `byo-admin.ts`
 * deliberately omits it).
 */

/** Refusals a visitor can cause. Everything else throws. */
export type ByoRegistrationErrorCode =
  | "invalid_issuer"
  | "discovery_failed"
  | "registration_unsupported"
  | "rate_limited";

export type ByoRegistrationInput = {
  issuer: string;
  clientId?: string;
  clientSecret?: string;
  /**
   * The federated callback RFC 7591 registration must name.
   *
   * It is `stableFederatedRedirectUri(config)` — one URL for the whole
   * deployment —
   * because a registration happens once and the IdP that issued the client
   * then matches its redirect_uri exactly. A URL naming the interaction it was
   * registered from would admit that visitor once and refuse every later
   * sign-in (ADR 0055); `routes/federated-callback.ts` is the callback, and it
   * hands the browser back to the interaction the `state` names. Optional, so
   * every frozen C9 call site still compiles; the manual path never reads it.
   */
  redirectUri?: string;
};

export type ByoRegistrationResult =
  | { record: ByoUpstream }
  | { error: ByoRegistrationErrorCode; message: string };

/**
 * One message for "no such issuer", "that host is not reachable from here"
 * and "that URL is not https". A visitor typing their own issuer needs to know
 * the URL was refused; nobody needs to know which rule refused it.
 */
const INVALID_ISSUER_MESSAGE =
  "That issuer URL cannot be used for sign-in from this server.";
const DISCOVERY_FAILED_MESSAGE =
  "That issuer did not answer with an OpenID Connect discovery document.";
const REGISTRATION_UNSUPPORTED_MESSAGE =
  "That issuer does not register clients automatically. Enter a client ID you created there.";
const RATE_LIMITED_MESSAGE =
  "Too many provider registrations from here. Try again in a few minutes.";

/** Longer than any real issuer; a URL this long is not one. */
const MAX_ISSUER_LENGTH = 512;
/** Client identifiers and secrets an IdP hands a human to paste back. */
const MAX_CLIENT_FIELD_LENGTH = 512;
const DISCOVERY_TIMEOUT_MS = 5_000;

const BUDGET_WINDOW_MS = 10 * 60_000;
const BUDGET_PER_FINGERPRINT = 5;
/** Bounded so a fingerprint flood cannot grow the map without limit. */
const BUDGET_MAX_KEYS = 2048;

/**
 * The discovery budget, module-local by contract (D5).
 *
 * It is not on `AppContext` deliberately: a per-request context object would
 * hand every request a fresh budget, and a store-backed one would make an
 * abuse fence depend on the database being up. One map per process, reset only
 * by `resetByoBudget`.
 */
const registrationBudget = new Map<string, number[]>();

/** Test hook: drop every recorded registration attempt. */
export function resetByoBudget(): void {
  registrationBudget.clear();
}

function consumeRegistrationBudget(fingerprint: string, now: number): boolean {
  for (const [key, attempts] of registrationBudget) {
    const live = attempts.filter((at) => now - at < BUDGET_WINDOW_MS);
    if (live.length === 0) registrationBudget.delete(key);
    else if (live.length !== attempts.length) registrationBudget.set(key, live);
  }
  const attempts = registrationBudget.get(fingerprint) ?? [];
  if (attempts.length >= BUDGET_PER_FINGERPRINT) return false;
  attempts.push(now);
  registrationBudget.set(fingerprint, attempts);
  while (registrationBudget.size > BUDGET_MAX_KEYS) {
    const victim = registrationBudget.keys().next().value;
    if (victim === undefined) break;
    registrationBudget.delete(victim);
  }
  return true;
}

/** Internal control flow; every instance becomes a result-shaped refusal. */
class ByoRegistrationError extends Error {
  override readonly name = "ByoRegistrationError";
  readonly code: ByoRegistrationErrorCode;

  constructor(code: ByoRegistrationErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Loopback literals a dev stack federates to.
 *
 * `assertSafeMetadataUrl` refuses loopback outright, and it is right to: in
 * production nothing a visitor names should resolve to this machine. But the
 * reference IdP and the whole local stack live on `127.0.0.1`, so a deployment
 * that already opted into dev defaults (never production —
 * `assertSecureConfig` forbids the combination) gets exactly this exception:
 * an IP LITERAL in 127/8 or `::1`. Names are deliberately excluded, including
 * `localhost` and `*.localhost`, because a name can be made to resolve
 * anywhere and the guard would then be judging the wrong thing.
 */
function isDevLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "::1") return true;
  const octets = host.split(".");
  if (octets.length !== 4) return false;
  return (
    octets[0] === "127" &&
    octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/**
 * The fence in front of every URL this module dereferences: the issuer the
 * visitor typed, and the `registration_endpoint` their discovery document
 * names. Both are equally untrusted — a document is not an authority.
 */
function assertSafeUpstreamUrl(ctx: AppContext, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ByoRegistrationError("invalid_issuer", INVALID_ISSUER_MESSAGE);
  }
  if (url.username || url.password) {
    throw new ByoRegistrationError("invalid_issuer", INVALID_ISSUER_MESSAGE);
  }
  const httpAllowed = ctx.config.allowDevDefaults && url.protocol === "http:";
  if (url.protocol !== "https:" && !httpAllowed) {
    throw new ByoRegistrationError("invalid_issuer", INVALID_ISSUER_MESSAGE);
  }
  if (ctx.config.allowDevDefaults && isDevLoopbackHost(url.hostname)) {
    return url;
  }
  try {
    return assertSafeMetadataUrl(url.href);
  } catch (error) {
    if (error instanceof UnsafeMetadataUrlError) {
      throw new ByoRegistrationError("invalid_issuer", INVALID_ISSUER_MESSAGE);
    }
    throw error;
  }
}

function trimmedField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > MAX_CLIENT_FIELD_LENGTH) return undefined;
  return trimmed;
}

/**
 * Read the issuer's discovery document through the guard.
 *
 * Redirects are refused rather than followed: a 302 to `169.254.169.254`
 * would otherwise walk straight past a check that only ever sees the first
 * URL. The `issuer` claim must match what the visitor typed — an OIDC issuer
 * that disagrees with its own document is not the issuer we would be
 * federating to, and the record is keyed by that string.
 */
async function discoverIssuerMetadata(
  ctx: AppContext,
  issuer: string,
): Promise<JsonObject> {
  const url = assertSafeUpstreamUrl(
    ctx,
    `${issuer}/.well-known/openid-configuration`,
  );
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch {
    throw new ByoRegistrationError(
      "discovery_failed",
      DISCOVERY_FAILED_MESSAGE,
    );
  }
  if (!response.ok) {
    throw new ByoRegistrationError(
      "discovery_failed",
      DISCOVERY_FAILED_MESSAGE,
    );
  }
  let document: JsonObject;
  try {
    const parsed = overlapCast(await response.json());
    if (!isJsonObject(parsed)) throw new Error("not a JSON object");
    document = parsed;
  } catch {
    throw new ByoRegistrationError(
      "discovery_failed",
      DISCOVERY_FAILED_MESSAGE,
    );
  }
  const declared = readString(document.issuer);
  if (!declared || normalizeIssuer(declared) !== issuer) {
    throw new ByoRegistrationError(
      "discovery_failed",
      DISCOVERY_FAILED_MESSAGE,
    );
  }
  return document;
}

type RegisteredClient = {
  clientId: string;
  clientSecret?: string;
  clientAuth: ByoUpstreamClientAuth;
};

/**
 * Client-authentication methods offered to the upstream, in preference order.
 *
 * `client_secret_post` first because a confidential client is the stronger
 * registration: the code exchange then proves possession of a secret only this
 * server holds. `none` is the fallback for an IdP that only registers public
 * clients — PKCE still binds the exchange, which is what a public client has.
 */
const REGISTRATION_AUTH_METHODS = ["client_secret_post", "none"] as const;

/**
 * RFC 7591 dynamic client registration through openid-client's own helper
 * (T24: the API name and shape were read from the installed 6.8.7 `.d.ts`,
 * `dynamicClientRegistration(server, metadata, clientAuthentication?,
 * options?) => Promise<Configuration>`).
 *
 * The helper re-runs discovery itself before posting to the endpoint it finds,
 * so the guard rides along as a custom fetch: without it an issuer could serve
 * one document to our check and a second one — pointing registration at a
 * private address — to the library a moment later.
 */
async function registerDynamically(
  ctx: AppContext,
  issuerUrl: URL,
  redirectUri: string,
): Promise<RegisteredClient> {
  const guardedFetch: client.CustomFetch = (url, options) => {
    assertSafeUpstreamUrl(ctx, url);
    // SAFETY: CustomFetchOptions is the fetch init openid-client already built
    // (method/headers/body/signal); only the redirect policy is added.
    const init: RequestInit = overlapCast({ ...options, redirect: "error" });
    return fetch(url, init);
  };
  const options: client.DynamicClientRegistrationRequestOptions = {
    [client.customFetch]: guardedFetch,
    ...(ctx.config.allowDevDefaults
      ? { execute: [client.allowInsecureRequests] }
      : undefined),
  };

  for (const method of REGISTRATION_AUTH_METHODS) {
    try {
      const configuration = await client.dynamicClientRegistration(
        issuerUrl,
        {
          client_name: `OpenSesame (${new URL(ctx.config.publicUrl).host})`,
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: method,
          application_type: "web",
        },
        undefined,
        options,
      );
      const registered = configuration.clientMetadata();
      const clientSecret = trimmedField(registered.client_secret);
      if (!registered.client_id) break;
      return {
        clientId: registered.client_id,
        ...(clientSecret !== undefined ? { clientSecret } : undefined),
        clientAuth: clientSecret !== undefined ? "client_secret_post" : "none",
      };
    } catch (cause) {
      // A blocked registration endpoint is a refusal, not something to retry
      // under a different client-authentication method.
      if (cause instanceof ByoRegistrationError) throw cause;
    }
  }
  throw new ByoRegistrationError(
    "registration_unsupported",
    REGISTRATION_UNSUPPORTED_MESSAGE,
  );
}

function issuerLabel(issuerUrl: URL): string {
  return issuerUrl.host;
}

async function persist(
  ctx: AppContext,
  issuer: string,
  issuerUrl: URL,
  registered: RegisteredClient,
  source: ByoUpstreamRegistrationSource,
): Promise<ByoUpstream> {
  const record: ByoUpstream = {
    id: `byo_${randomUUID()}`,
    issuer,
    label: issuerLabel(issuerUrl),
    clientId: registered.clientId,
    ...(registered.clientSecret !== undefined
      ? { clientSecret: registered.clientSecret }
      : undefined),
    clientAuth: registered.clientAuth,
    registrationSource: source,
    state: "active",
    createdAt: ctx.clock(),
  };

  let created: ByoUpstream;
  try {
    created = await ctx.repos.byoUpstreams.create(record);
  } catch (cause) {
    // Two tabs, one issuer: the unique index is the arbiter, and the loser of
    // that race gets the row the winner wrote rather than an error page.
    const existing = await ctx.repos.byoUpstreams.findByIssuer(issuer);
    if (existing?.state === "active") return existing;
    throw cause;
  }

  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "byo_upstream.registered",
    outcome: "succeeded",
    actorType: "system",
    correlationId: `byo-register-${created.id}`,
    targetType: "byo_upstream",
    targetId: created.id,
    // Issuer and provenance only. The client secret this row may carry is the
    // one thing an audit trail must never grow a copy of (T19).
    metadata: {
      action: "byo_upstream.register",
      issuer: created.issuer,
      via: source === "dcr" ? "dynamic_registration" : "visitor_supplied",
    },
  });
  ctx.log.info(
    { issuer: created.issuer, registrationSource: source },
    "registered a bring-your-own upstream",
  );
  return created;
}

async function register(
  ctx: AppContext,
  input: ByoRegistrationInput,
  fingerprint: string,
): Promise<ByoUpstream> {
  const issuer = normalizeIssuer(input.issuer ?? "");
  if (!issuer || issuer.length > MAX_ISSUER_LENGTH) {
    throw new ByoRegistrationError("invalid_issuer", INVALID_ISSUER_MESSAGE);
  }
  const issuerUrl = assertSafeUpstreamUrl(ctx, issuer);

  // The budget sits in front of the store lookup as well as the network: a
  // stranger enumerating issuers against this endpoint is exactly the traffic
  // it exists to stop, and answering "already registered" cheaply would make
  // the enumeration free.
  if (!consumeRegistrationBudget(fingerprint, ctx.clock().getTime())) {
    throw new ByoRegistrationError("rate_limited", RATE_LIMITED_MESSAGE);
  }

  const existing = await ctx.repos.byoUpstreams.findByIssuer(issuer);
  if (existing) {
    // Idempotent by issuer: the returning visitor re-types their URL and signs
    // in with the record they already have. Nothing is re-registered, no
    // submitted credential overwrites the stored one — a stranger who guesses
    // somebody else's issuer must not be able to swap the client out from
    // under it — and the answer is the same one a first-time registration
    // gives, so it reveals nothing about pre-existence.
    if (existing.state !== "active") {
      // An operator disabled this record (D14). It signs nobody in, and it
      // must not be re-created around: same refusal a stranger would get.
      throw new ByoRegistrationError(
        "discovery_failed",
        DISCOVERY_FAILED_MESSAGE,
      );
    }
    return existing;
  }

  // Discovery runs even when the visitor brought their own client id: it is
  // what proves the URL is an OIDC issuer at all, and a record whose issuer
  // publishes no discovery document could never complete a leg.
  const metadata = await discoverIssuerMetadata(ctx, issuer);

  const clientId = trimmedField(input.clientId);
  if (clientId) {
    const clientSecret = trimmedField(input.clientSecret);
    return persist(
      ctx,
      issuer,
      issuerUrl,
      {
        clientId,
        ...(clientSecret !== undefined ? { clientSecret } : undefined),
        clientAuth: clientSecret !== undefined ? "client_secret_post" : "none",
      },
      "manual",
    );
  }

  const registrationEndpoint = readString(metadata.registration_endpoint);
  const redirectUri = input.redirectUri;
  if (!registrationEndpoint || !redirectUri) {
    // No credentials to use and no way to obtain any: the visitor has to
    // register a client at their own IdP and bring its id back.
    throw new ByoRegistrationError(
      "registration_unsupported",
      REGISTRATION_UNSUPPORTED_MESSAGE,
    );
  }
  assertSafeUpstreamUrl(ctx, registrationEndpoint);
  const registered = await registerDynamically(ctx, issuerUrl, redirectUri);
  return persist(ctx, issuer, issuerUrl, registered, "dcr");
}

/**
 * Register (or recover) the bring-your-own upstream a visitor named (C9/D5).
 *
 * `fingerprint` is the caller's abuse key — the same user-agent-derived digest
 * the interaction routes already mint — and is spent on every attempt that
 * gets past URL validation.
 */
export async function registerByoUpstream(
  ctx: AppContext,
  input: ByoRegistrationInput,
  fingerprint: string,
): Promise<ByoRegistrationResult> {
  try {
    return { record: await register(ctx, input, fingerprint) };
  } catch (error) {
    if (error instanceof ByoRegistrationError) {
      return { error: error.code, message: error.message };
    }
    throw error;
  }
}
