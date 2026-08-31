import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import {
  ApproveInteractionSchema,
  CreateInteractionSchema,
  DenyInteractionSchema,
  InteractionCreatedResponseSchema,
  InteractionDetailResponseSchema,
  type InteractionErrorCode,
  InteractionListResponseSchema,
  InteractionSummaryResponseSchema,
} from "@opensesame/contracts";
import { ConflictError } from "@opensesame/database";
import {
  type ApprovalProof,
  type AssuranceLevel,
  type AuthorizationDetail,
  DomainError,
  FORBIDDEN_URL_PARAMS,
  type Interaction,
  type InteractionStatus,
  type JsonObject,
  assertAuthorizationDetails,
  bindingMessageDigest,
  canonicalRequestDigest,
  deriveBindingMessage,
  interactionMachine,
  mintInteractionRef,
  overlapCast,
  resolveInteractionRef,
} from "@opensesame/os-domain";
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppContext } from "../context.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import {
  claimPageSecurityHeaders,
  escapeHtml,
} from "../middleware/security-headers.js";
import { authenticatedPrincipalId } from "./organizations.js";

/**
 * The cross-device interaction handoff (ADR 0086).
 *
 * One envelope for every human moment this system runs — approve this device,
 * claim this resource, allow this call, authorize this payment — addressed by
 * an opaque reference that is safe to print, photograph and put in a wallet
 * pass, because holding one authorizes nothing.
 *
 * Two mounts, and the split is the design:
 *
 * - `/v1/interactions` — the JSON API. Creating, reading in full, deciding,
 *   spending, withdrawing. Every route here costs an authenticated principal.
 * - `/i/:ref` — the canonical short link, unauthenticated. It answers with an
 *   `InteractionSummary` and nothing else, and it records that somebody looked.
 *
 * Note the collision hazard this file is named around: `/interaction`
 * (singular, unversioned, `routes/interactions.ts`) is the oidc-provider
 * login/consent slot and has nothing to do with any of this. The version
 * prefix is what keeps them apart, which is why there is no unversioned
 * `/interactions`.
 *
 * Three invariants carry the security weight, and every handler below is
 * downstream of one of them:
 *
 * 1. **Scanning is not approving.** Resolving a reference moves an interaction
 *    to `presented` — a display fact with its own state, deliberately not
 *    wired to consent — and returns four fields that say nothing about who is
 *    asking whom for what.
 * 2. **The digest is the whole point.** What was displayed, what was approved
 *    and what will execute are the same operation because a decision must echo
 *    the stored `requestDigest` and carry a proof bound to it. The binding
 *    message is *derived* from the authorization details rather than taken
 *    from the requester, so the sentence on the screen and the operation
 *    behind it cannot be made to disagree.
 * 3. **Nothing here is an oracle.** A malformed reference, a forged MAC, an id
 *    that never existed, and an interaction belonging to somebody else are one
 *    answer at one cost: 404 `interaction_not_found`.
 */

/**
 * Statuses accepted as an inbox filter.
 *
 * An unrecognised `?status=` is ignored rather than refused, matching the
 * authorization-request inbox: a filter is a convenience, and 400-ing on a
 * typo would make the surface harder to use without making it safer.
 */
const INBOX_STATUS_FILTERS: readonly InteractionStatus[] = [
  "pending",
  "presented",
  "awaiting_approval",
  "approved",
  "denied",
  "consumed",
  "expired",
  "revoked",
];

/** Five minutes: long enough to reach for a phone, short enough to forget. */
const DEFAULT_TTL_SECONDS = 300;
/** The inbox listing ceiling. A bounded surface cannot be flooded into. */
const MAX_INBOX_ITEMS = 100;

/** One wire refusal: the stable code a client branches on, and its status. */
interface InteractionRefusal {
  code: InteractionErrorCode;
  status: ContentfulStatusCode;
}

/**
 * The one place an error code and its status are paired.
 *
 * Written as a table rather than as `return c.json(..., 409)` at a dozen call
 * sites because the statuses collapse: three distinct outcomes are 409, and a
 * handler that picks its own number is how one of them quietly becomes a 500
 * or a 200 later.
 */
const ERRORS = {
  interaction_not_found: { code: "interaction_not_found", status: 404 },
  interaction_expired: { code: "interaction_expired", status: 410 },
  interaction_revoked: { code: "interaction_revoked", status: 409 },
  interaction_consumed: { code: "interaction_consumed", status: 409 },
  interaction_settled: { code: "interaction_settled", status: 409 },
  interaction_already_live: { code: "interaction_already_live", status: 409 },
  approval_required: { code: "approval_required", status: 401 },
  digest_mismatch: { code: "digest_mismatch", status: 409 },
  unsupported_kind: { code: "unsupported_kind", status: 422 },
  invalid_request: { code: "invalid_request", status: 400 },
  rate_limited: { code: "rate_limited", status: 429 },
} as const satisfies Record<InteractionErrorCode, InteractionRefusal>;

type ErrorName = keyof typeof ERRORS;

function fail(c: Context<{ Variables: Variables }>, name: ErrorName) {
  const { code, status } = ERRORS[name];
  return c.json({ error: code }, status);
}

/**
 * The refusal a terminal interaction earns.
 *
 * Every terminal state gets its own code because the caller's next move
 * differs for each: a consumed interaction means the work already happened, a
 * revoked one means somebody withdrew it, an expired one means re-issue, and a
 * settled one means the decision stands. Folding them into one 409 would leave
 * a client with no way to tell "try again" from "stop".
 */
function terminalError(status: InteractionStatus): ErrorName {
  switch (status) {
    case "expired":
      return "interaction_expired";
    case "revoked":
      return "interaction_revoked";
    case "consumed":
      return "interaction_consumed";
    default:
      return "interaction_settled";
  }
}

/**
 * An opaque handle for whoever is asking.
 *
 * Derived exactly as the authorization-request inbox derives it, and with the
 * same purpose string, so one requester has one handle across both surfaces —
 * a relay that sees `req_…` on an interaction and on an inbox item is looking
 * at the same asker. The canonical principal id does not travel here: this
 * value reaches an approver's screen and, once relay lands, crosses bus
 * subjects that are not private (ADR 0042 subject hygiene).
 */
function requesterRef(principalId: string, pepper: string): string {
  return `req_${createHash("sha256")
    .update(`opensesame:requester-ref:v1\0${pepper}\0${principalId}`)
    .digest("base64url")
    .slice(0, 24)}`;
}

/** The inbox handle for a principal, byte-identical to the inbox route's. */
function inboxRef(principalId: string, pepper: string): string {
  const body = Buffer.from(principalId, "utf8").toString("base64url");
  const tag = createHmac("sha256", pepper)
    .update(`opensesame:inbox-ref:v1\0${principalId}`)
    .digest("base64url")
    .slice(0, 32);
  return `inbox_${body}.${tag}`;
}

/**
 * The principal an `inbox_…` handle addresses, or null if it was not minted
 * here.
 *
 * Interactions address an approver by the same handle the authorization-request
 * inbox issues (`GET /v1/authorization-requests/inbox-ref`), so this must
 * reproduce that derivation byte for byte — a second handle family would mean
 * a user holding one address that works on one surface and not the other, and
 * whichever surface was easier to reach would become the one attackers use.
 *
 * A handle that does not verify and a handle for a principal that no longer
 * exists both answer 404 at the call site, so there is no oracle left to query.
 */
function resolveInboxRef(ref: string, pepper: string): string | null {
  if (!ref.startsWith("inbox_")) return null;
  const [body, tag] = ref.slice("inbox_".length).split(".");
  if (!body || !tag) return null;
  let principalId: string;
  try {
    principalId = Buffer.from(body, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!principalId) return null;
  const expected = inboxRef(principalId, pepper);
  // Constant-time: the tag is a MAC, and a byte-by-byte compare with an early
  // exit is a forgery oracle for a caller who can time the answer.
  const a = Buffer.from(ref, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return principalId;
}

/**
 * The canonical link for a reference.
 *
 * HTTPS and nothing else (ADR 0086 §2): a custom scheme cannot be opened by a
 * camera app, cannot be a wallet barcode value that degrades to a web page,
 * and cannot be checked against the browser's origin model.
 *
 * The forbidden-parameter sweep looks vacuous — this builder appends no query
 * at all — and it is not. `publicUrl` is operator-configured, and a deployment
 * whose public URL carried `?token=…` would otherwise print that token into
 * every QR code, wallet pass and terminal this service hands out. Refusing at
 * the point of construction is the only place that catches it, because after
 * this function the string is just a URL somebody displays.
 */
function interactionUrl(publicUrl: string, ref: string): string {
  const url = new URL(`/i/${encodeURIComponent(ref)}`, publicUrl);
  const named = [
    ...url.searchParams.keys(),
    ...new URLSearchParams(url.hash.replace(/^#/, "")).keys(),
  ].map((name) => name.toLowerCase());
  const forbidden = named.find((name) => FORBIDDEN_URL_PARAMS.includes(name));
  if (forbidden) {
    throw new Error(
      `interaction URL would carry a forbidden parameter: ${forbidden}`,
    );
  }
  return url.toString();
}

/**
 * Persist an expiry that was observed on read.
 *
 * `maybeExpire` is a pure projection: without this, a lapsed interaction stays
 * `pending` forever, holds a slot in the store's one-live-per-ceremony index
 * ahead of the replacement somebody is trying to issue, and nothing ever sheds
 * it. Racing writers are the normal case — whoever settles it first wins — so
 * a conflict here is not a failure and the caller sees the projection either
 * way.
 */
async function persistExpiry(
  ctx: AppContext,
  row: Interaction,
  now: Date,
): Promise<Interaction> {
  const projected = interactionMachine.maybeExpire(row, now);
  if (projected.status !== "expired" || row.status === "expired") {
    return projected;
  }
  try {
    return await ctx.repos.interactions.updateWithVersion(row.id, row.version, {
      status: "expired",
    });
  } catch {
    return projected;
  }
}

/**
 * The interaction a reference addresses, with expiry already projected.
 *
 * Null for a malformed reference, a forged MAC, and an id that never existed
 * alike — `resolveInteractionRef` refuses a fabricated reference before any
 * lookup happens, so those three cost the same and answer the same. Callers
 * apply their own entitlement check on top and answer 404 for that too.
 */
async function loadByRef(
  ctx: AppContext,
  ref: string,
  now: Date,
): Promise<Interaction | null> {
  const id = resolveInteractionRef(ref, ctx.config.claimPepper);
  if (!id) return null;
  const row = await ctx.repos.interactions.getById(id);
  if (!row) return null;
  return persistExpiry(ctx, row, now);
}

/**
 * Per-reference pacing for links that verify.
 *
 * Generous, because a real scan is followed by a page load, a sign-in and a
 * poll or two, and several people may hold the same link. Tight enough that
 * the endpoint is not a free status feed on somebody else's approval.
 */
const REFERENCE_BUDGET = 120;
const referenceAttempts = new Map<string, number[]>();

function consumeReferenceBudget(ref: string): boolean {
  const now = Date.now();
  // Same shedding discipline as the probing budget: the map is keyed by a
  // value a caller supplies, so it must be bounded whatever they send.
  for (const [key, values] of referenceAttempts) {
    const live = values.filter((at) => now - at < LINK_WINDOW_MS);
    if (live.length === 0) referenceAttempts.delete(key);
    else if (live.length !== values.length) referenceAttempts.set(key, live);
  }
  while (referenceAttempts.size > LINK_FENCE_ENTRIES) {
    const oldest = referenceAttempts.keys().next().value;
    if (oldest === undefined) break;
    referenceAttempts.delete(oldest);
  }
  const seen = referenceAttempts.get(ref) ?? [];
  if (seen.length >= REFERENCE_BUDGET) return false;
  referenceAttempts.set(ref, [...seen, now]);
  return true;
}

/** True when a reference was minted here. One HMAC; no database. */
function referenceVerifies(ctx: AppContext, ref: string): boolean {
  return resolveInteractionRef(ref, ctx.config.claimPepper) !== null;
}

/** True when the caller is the principal the interaction is asking. */
function isApprover(row: Interaction, principalId: string): boolean {
  return row.approverPrincipalId === principalId;
}

/** True when the caller is the principal that raised the interaction. */
function isRequester(
  ctx: AppContext,
  row: Interaction,
  principalId: string,
): boolean {
  return (
    row.requesterRef !== undefined &&
    row.requesterRef === requesterRef(principalId, ctx.config.claimPepper)
  );
}

/**
 * What a bare reference is worth.
 *
 * Four fields. Not a subset of the detail with the sensitive parts stripped —
 * a separate projection, so widening it is a deliberate edit here rather than
 * a field quietly appearing because it was added to the row.
 */
function toSummary(row: Interaction) {
  // Parsed through the contract, not merely typed by it. Zod strips keys the
  // schema does not name, so a field added to this object later — a requester
  // handle, a binding message — cannot reach a scanner even if nobody notices
  // the addition in review. The narrowest projection in the system is the one
  // that should be enforced at runtime.
  return InteractionSummaryResponseSchema.parse({
    kind: row.kind,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    // Every kind this envelope fronts asks somebody for something; the field
    // exists so a client renders "sign in to continue" from the summary alone
    // rather than inferring it from the kind.
    requiresApprover: true,
  });
}

/**
 * The authenticated approver's view.
 *
 * `subject.subjectId` is absent by construction: the approver acts through the
 * interaction and never needs the fronted row's id, so a reference can never
 * be traded for a device-session or authorization-request id. The approval
 * proof is absent for a different reason — it is a record for executors and
 * auditors, not something a decision screen reads back.
 */
function toDetail(row: Interaction) {
  return InteractionDetailResponseSchema.parse({
    ...toSummary(row),
    id: row.id,
    ...(row.requesterRef ? { requesterRef: row.requesterRef } : undefined),
    ...(row.bindingMessage
      ? { bindingMessage: row.bindingMessage }
      : undefined),
    ...(row.requestDigest ? { requestDigest: row.requestDigest } : undefined),
    authorizationDetails: row.authorizationDetails,
    ...(row.resourceRef ? { resourceRef: row.resourceRef } : undefined),
    createdAt: row.createdAt.toISOString(),
    ...(row.decidedAt ? { decidedAt: row.decidedAt.toISOString() } : undefined),
  });
}

/**
 * Audit metadata for an interaction, and the list is exhaustive on purpose.
 *
 * The reference is not here: a reference is what a stranger holding a
 * photographed QR has, and an audit store is not the place to hand a reader
 * one. The binding message is not here either — it quotes attacker-authorable
 * text (a payee name, a repo path) — so the *digest* of it goes instead, which
 * is enough to prove which words were on the screen without storing the words.
 * Authorization details never appear at all: they are the request, and a
 * request in an audit row is a request an attacker can write into one.
 */
function auditMetadata(row: Interaction): JsonObject {
  return {
    interactionId: row.id,
    interactionKind: row.kind,
    subjectKind: row.subject.kind,
    // `subjectId` is deliberately absent. The whole layer rests on a reference
    // never being convertible into the id of the row it fronts, and the audit
    // read route hands a principal back the metadata of events they are the
    // subject of — so writing it here would have let an approver read the
    // device-session or authorization-request id behind any interaction they
    // were shown. The kind is enough to review a decision; the id is the part
    // that was never supposed to travel.
    ...(row.requestDigest ? { requestDigest: row.requestDigest } : undefined),
    ...(row.bindingMessageDigest
      ? { bindingMessageDigest: row.bindingMessageDigest }
      : undefined),
  };
}

/**
 * Zod's complaint, reduced to the paths it complained about.
 *
 * The message itself never travels. Zod renders the *received* value into some
 * issue messages, and the values arriving here include authorization details a
 * requester wrote — which is precisely the material the payment-credential
 * guard exists to keep out of logs and responses. Paths name the offending
 * field and cannot carry a value.
 */
function invalidFields(issues: readonly { path: PropertyKey[] }[]): string[] {
  return issues.slice(0, 8).map((issue) => issue.path.join("."));
}

/**
 * Map a domain refusal onto the wire vocabulary.
 *
 * `EXPIRED` is the machine's own clock check, which runs on every transition
 * rather than only in a sweeper, so it can fire on a row that still reads
 * `pending`. An `INVALID_TRANSITION` is read against the row's current status,
 * because "you cannot approve this" means something different when it was
 * revoked than when it was already approved.
 */
function domainErrorName(error: DomainError, row: Interaction): ErrorName {
  if (error.code === "EXPIRED") return "interaction_expired";
  if (error.code === "INVALID_TRANSITION") return terminalError(row.status);
  return "invalid_request";
}

/**
 * A sliding-window budget for the unauthenticated short link.
 *
 * Module-global because it must outlive a request, bounded because it is keyed
 * by client-influenced values, and wall-clock rather than `ctx.clock()` because
 * pacing is about real elapsed time and a test's frozen clock must not be able
 * to hold a window open.
 *
 * This is not the enumeration defence — a reference carries 144 bits of
 * randomness *and* a MAC, so guessing is not a strategy anybody has, and a
 * forged reference is refused before any database lookup. What the budget
 * actually buys is that the endpoint cannot be turned into a free HMAC
 * verification loop against the deployment pepper.
 *
 * **Only unverifiable references spend it.** That asymmetry is the whole
 * design, and getting it backwards is worse than having no budget at all. A
 * caller holding a reference that verifies was handed the link; a caller
 * sending one that does not is probing. If both spent from a shared bucket,
 * an attacker rotating the two headers this fingerprint is built from — which
 * costs them nothing — could exhaust a global cap and every genuine QR scan on
 * the instance would answer 429. The evadable limit would constrain honest
 * users and the unevadable one would deny them, which is precisely inverted
 * for a feature whose premise is that somebody is standing in front of a
 * screen right now.
 *
 * So verification comes first, it is one HMAC and touches no database, and a
 * genuine link is never paced by what somebody else is doing.
 */
const LINK_WINDOW_MS = 60_000;
const LINK_GLOBAL_BUDGET = 3_000;
const LINK_CLIENT_BUDGET = 240;
const LINK_FENCE_ENTRIES = 4_096;
const linkAttempts = new Map<string, number[]>();

/**
 * Test hook: clear the short-link budget.
 *
 * Module-global state outlives the app instance a suite builds, so a suite
 * that resolves hundreds of links would otherwise pace the next one.
 */
export function resetInteractionLinkBudget(): void {
  linkAttempts.clear();
  referenceAttempts.clear();
}

function consumeLinkBudget(c: Context<{ Variables: Variables }>): boolean {
  const now = Date.now();
  for (const [key, values] of linkAttempts) {
    const live = values.filter((at) => now - at < LINK_WINDOW_MS);
    if (live.length === 0) linkAttempts.delete(key);
    else if (live.length !== values.length) linkAttempts.set(key, live);
  }
  while (linkAttempts.size > LINK_FENCE_ENTRIES) {
    const oldest = linkAttempts.keys().next().value;
    if (oldest === undefined) break;
    linkAttempts.delete(oldest);
  }
  const fingerprint = createHash("sha256")
    .update(c.req.header("user-agent") ?? "")
    .update("|")
    .update(c.req.header("x-forwarded-for") ?? c.req.header("origin") ?? "")
    .digest("hex")
    .slice(0, 16);
  const global = linkAttempts.get("__global__") ?? [];
  const client = linkAttempts.get(fingerprint) ?? [];
  if (
    global.length >= LINK_GLOBAL_BUDGET ||
    client.length >= LINK_CLIENT_BUDGET
  ) {
    return false;
  }
  linkAttempts.set("__global__", [...global, now]);
  linkAttempts.set(fingerprint, [...client, now]);
  return true;
}

/** True when the caller asked for JSON rather than a page to look at. */
function wantsJson(c: Context<{ Variables: Variables }>): boolean {
  return (c.req.header("accept") ?? "")
    .toLowerCase()
    .includes("application/json");
}

/**
 * The page a person lands on after scanning.
 *
 * Server-rendered, no script, no images, everything escaped — the CSP from
 * `claimPageSecurityHeaders` allows inline styles and nothing else. It says
 * what kind of question is waiting and when it lapses, and directs the reader
 * to sign in, because the reference itself grants nothing and the page must
 * not imply otherwise.
 */
function summaryPage(title: string, lines: readonly string[]): string {
  const body = lines.map((line) => `    <p>${escapeHtml(line)}</p>`).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>OpenSesame</title>
  <style>
    body{font-family:system-ui,sans-serif;margin:2rem;background:#0f1419;color:#e7ecf3}
    main{max-width:32rem}
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
${body}
  </main>
</body>
</html>`;
}

/** Prose for a kind, for the landing page only. Never used for a decision. */
const KIND_PROSE = {
  device_authorization: "approve a device",
  pairing: "pair a device",
  claim: "claim a resource",
  grant_claim: "grant a claim",
  authorization_request: "authorize a request",
  transaction_authorization: "authorize a transaction",
} as const satisfies Record<Interaction["kind"], string>;

/**
 * The canonical short link, `/i/:ref` — unauthenticated by design.
 *
 * It is reached by a camera, a wallet pass, a pasted link and whoever picked
 * up the printout, so it answers with a summary and records that somebody
 * looked. Presentation is idempotent: a pass opened twice, or a QR read by
 * both the camera app and the browser, is one event, because it is a display
 * fact and never an authorization fact.
 */
export function createInteractionLinkRoutes(): Hono<{ Variables: Variables }> {
  const routes = new Hono<{ Variables: Variables }>();
  routes.use("*", claimPageSecurityHeaders());

  routes.get("/:ref", async (c) => {
    const ctx = c.get("ctx");
    const json = wantsJson(c);
    const ref = c.req.param("ref") ?? "";

    // Pacing applies to probing, not to arriving with a link somebody gave
    // you. Verification is one HMAC and touches no database, so it is safe to
    // do before the budget check — and doing it in this order is what keeps a
    // flood of forged references from denying the endpoint to real scanners.
    //
    // A reference that verifies is still metered, but against its own bucket
    // rather than a shared one. Otherwise a photographed link becomes an
    // unmetered status feed: poll it and watch `pending → presented →
    // awaiting_approval → approved`, which is a side channel on what the
    // approver is doing. Per-reference means hammering one link paces that
    // link and nobody else's.
    const paced = referenceVerifies(ctx, ref)
      ? consumeReferenceBudget(ref)
      : consumeLinkBudget(c);
    if (!paced) {
      return json
        ? fail(c, "rate_limited")
        : c.html(
            summaryPage("Too many requests", [
              "Try opening this link again in a moment.",
            ]),
            429,
          );
    }

    const notFound = () =>
      json
        ? fail(c, "interaction_not_found")
        : c.html(
            summaryPage("Nothing to approve", [
              "This link is not valid, or the request behind it is gone.",
            ]),
            404,
          );

    const now = ctx.clock();
    const row = await loadByRef(ctx, ref, now);
    if (!row) return notFound();
    if (row.status === "expired") {
      return json
        ? fail(c, "interaction_expired")
        : c.html(
            summaryPage("This request has expired", [
              "Start it again from the device that asked.",
            ]),
            410,
          );
    }

    // A terminal interaction still resolves, and that is what makes a
    // photographed QR useless after the fact: it resolves to `consumed`. Only
    // a live one is moved to `presented`; `present` would refuse a terminal
    // row anyway, and asking it to is how a handler grows a swallowed throw.
    let current = row;
    if (!interactionMachine.isTerminal(row.status)) {
      const projected = interactionMachine.present(row, now);
      if (projected.status !== row.status) {
        try {
          current = await ctx.repos.interactions.updateWithVersion(
            row.id,
            row.version,
            { status: "presented", presentedAt: now },
          );
        } catch {
          // Somebody else moved it between the read and the write — an
          // approver who reached the detail route first, most likely. The
          // projection is what the scanner is shown; a display fact is not
          // worth failing a page render over.
          current = projected;
        }
      }
    }

    if (json) return c.json(toSummary(current));
    return c.html(
      summaryPage(`Someone is asking you to ${KIND_PROSE[current.kind]}`, [
        `Status: ${current.status}.`,
        `This request lapses at ${current.expiresAt.toISOString()}.`,
        "Sign in to OpenSesame on this device to see what is being asked and answer it.",
      ]),
    );
  });

  return routes;
}

/**
 * The JSON API at `/v1/interactions`.
 *
 * Entitlement differs per route and is stated at each one rather than in a
 * shared loader, because the three roles are genuinely different: only the
 * approver reads the detail and decides, only the requester spends the
 * approval, and either may withdraw. Every failed entitlement check answers
 * 404, so the id space stays unenumerable and nothing here confirms that a
 * principal or a subject exists.
 */
export function createInteractionHandoffRoutes(): Hono<{
  Variables: Variables;
}> {
  const routes = new Hono<{ Variables: Variables }>();

  /**
   * Raise an interaction over a ceremony.
   *
   * The server derives everything that matters. The binding message comes from
   * `deriveBindingMessage` over the same authorization details the digest
   * covers — a requester-written sentence is a sentence a requester can make
   * disagree with what executes ("confirm your session" over a payment) — and
   * the digest, the reference, the window and the requester handle are all
   * server-side. The body supplies the request; it does not supply the words.
   */
  routes.post(
    "/",
    requirePrincipal(),
    idempotencyMiddleware("interactions.create"),
    async (c) => {
      const ctx = c.get("ctx");
      const callerId = authenticatedPrincipalId(c.get("principalId"));
      const parsed = CreateInteractionSchema.safeParse(
        await c.req.json().catch(() => ({})),
      );
      if (!parsed.success) {
        return c.json(
          {
            error: ERRORS.invalid_request.code,
            fields: invalidFields(parsed.error.issues),
          },
          ERRORS.invalid_request.status,
        );
      }
      const body = parsed.data;
      // The envelope's kind and the fronted ceremony's kind are one fact
      // stored twice, and a mismatch is not a harmless inconsistency: the kind
      // is hashed into the digest, so an envelope that says
      // `transaction_authorization` over a `device_authorization` subject
      // would produce an approval whose digest describes one operation while
      // the row behind it settles another.
      if (body.subject.kind !== body.kind) {
        return fail(c, "unsupported_kind");
      }

      // Knowing the handle is what authorizes the asking. A handle that does
      // not verify, and one that verifies for a principal that is gone or must
      // not be asked, answer identically: nothing here confirms an id.
      const approverId = resolveInboxRef(
        body.approverRef,
        ctx.config.claimPepper,
      );
      const approver = approverId
        ? await ctx.repos.principals.getById(approverId)
        : null;
      if (
        !approverId ||
        !approver ||
        approver.state === "suspended" ||
        approver.state === "closed"
      ) {
        // A provisional principal is a legitimate approver — a guest can hold
        // delegated authority — so the state check refuses only principals that
        // must not be asked at all.
        return fail(c, "interaction_not_found");
      }

      const details: AuthorizationDetail[] = body.authorizationDetails.map(
        (detail) => overlapCast<typeof detail, AuthorizationDetail>(detail),
      );
      try {
        assertAuthorizationDetails(details);
      } catch (e) {
        if (e instanceof DomainError) {
          // The refusal names a JSON path and never a value — but a path is
          // built from object keys the requester chose, and a key can be
          // shaped like the very PAN the guard just refused. So the message
          // goes to the log, where it belongs, and the caller gets the code.
          ctx.log.warn(
            { err: e },
            "authorization details refused for interaction",
          );
          return c.json(
            {
              error: ERRORS.invalid_request.code,
              detail: "authorization_details refused",
            },
            422,
          );
        }
        throw e;
      }

      const now = ctx.clock();
      const expiresAt = new Date(
        now.getTime() + (body.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000,
      );
      const bindingMessage = deriveBindingMessage(details);
      const requester = requesterRef(callerId, ctx.config.claimPepper);
      const digest = canonicalRequestDigest({
        kind: body.kind,
        // Binds the approval to the record it settles, so two interactions
        // carrying identical details cannot share a digest.
        subject: `${body.subject.kind}:${body.subject.subjectId}`,
        // The approver's *handle*, not the principal id it resolves to: an
        // executor recomputing this digest has the handle and must never need
        // the id to do it.
        approverRef: body.approverRef,
        requesterRef: requester,
        authorizationDetails: details,
        bindingMessage,
        ...(body.resourceRef ? { resourceRef: body.resourceRef } : undefined),
        expiresAt: expiresAt.toISOString(),
      });
      const minted = mintInteractionRef(ctx.config.claimPepper);
      // Built before the row is written, not after. The forbidden-parameter
      // sweep inside is a deployment-wide check on `publicUrl`, so failing it
      // fails every create — and doing that *after* the insert would leave a
      // live interaction nobody was ever handed a link to, holding the
      // one-live-per-ceremony slot against the retry.
      const url = interactionUrl(ctx.config.publicUrl, minted.ref);
      const interaction: Interaction = {
        id: minted.id,
        kind: body.kind,
        status: "pending",
        subject: { kind: body.subject.kind, subjectId: body.subject.subjectId },
        createdAt: now,
        expiresAt,
        requesterRef: requester,
        // Recorded at creation, not at the approver's first read: the inbox
        // listing is how an approver finds a question nobody sent them a link
        // for, and a row that only learns its approver once it has been read
        // is a row that can never be found in order to read it.
        approverPrincipalId: approverId,
        requestDigest: digest,
        bindingMessageDigest: bindingMessageDigest(
          bindingMessage,
          ctx.config.claimPepper,
        ),
        bindingMessage,
        authorizationDetails: details,
        ...(body.resourceRef ? { resourceRef: body.resourceRef } : undefined),
        version: 1,
      };

      let created: Interaction;
      try {
        created = await ctx.repos.interactions.create(interaction);
      } catch (e) {
        // One live interaction per ceremony (ADR 0086). Two QR codes for one
        // device-authorization session would be two references a photograph
        // could capture, only one of which the obvious action revokes.
        if (e instanceof ConflictError)
          return fail(c, "interaction_already_live");
        throw e;
      }

      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "interaction.created",
        principalId: callerId,
        actorType: "human",
        outcome: "succeeded",
        correlationId: c.get("correlationId"),
        metadata: auditMetadata(created),
      });

      return c.json(
        InteractionCreatedResponseSchema.parse({
          ref: minted.ref,
          url,
          requestDigest: digest,
          bindingMessage,
          expiresAt: created.expiresAt.toISOString(),
          status: created.status,
        }),
        201,
      );
    },
  );

  /**
   * The approver's inbox.
   *
   * A survey, not a presentation: listing does not move anything to
   * `awaiting_approval`, because seeing that three questions exist is not the
   * same event as opening one. Full detail, because the caller is already the
   * approver and the digest they will have to echo has to come from somewhere.
   */
  routes.get("/", requirePrincipal(), async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const status = c.req.query("status");
    const parsedStatus = INBOX_STATUS_FILTERS.find((value) => value === status);
    const rows = await ctx.repos.interactions.listForApprover(principalId, {
      ...(parsedStatus ? { status: parsedStatus } : undefined),
      limit: MAX_INBOX_ITEMS,
    });
    const now = ctx.clock();
    const projected = await Promise.all(
      rows.map((row) => persistExpiry(ctx, row, now)),
    );
    // Re-filtered after projection: a row that lapsed since it was written is
    // `expired` now, and returning it under `?status=pending` would put a dead
    // question at the top of somebody's inbox.
    const visible = parsedStatus
      ? projected.filter((row) => row.status === parsedStatus)
      : projected;
    return c.json(
      InteractionListResponseSchema.parse({
        interactions: visible.map(toDetail),
      }),
    );
  });

  /**
   * The approver opens the question.
   *
   * This is the transition that says a human has the request in front of them,
   * so it is the approver's read and nobody else's — a requester polling for
   * an answer must not be able to report that their own request was seen.
   * Reading is idempotent; opening twice is one event.
   */
  routes.get("/:ref", requirePrincipal(), async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const now = ctx.clock();
    const row = await loadByRef(ctx, c.req.param("ref") ?? "", now);
    if (!row || !isApprover(row, principalId)) {
      return fail(c, "interaction_not_found");
    }
    if (row.status === "expired") return fail(c, "interaction_expired");
    if (interactionMachine.isTerminal(row.status)) return c.json(toDetail(row));

    const projected = interactionMachine.awaitApproval(row, principalId, now);
    if (projected.status === row.status) return c.json(toDetail(row));
    try {
      const saved = await ctx.repos.interactions.updateWithVersion(
        row.id,
        row.version,
        { status: "awaiting_approval", approverPrincipalId: principalId },
      );
      return c.json(toDetail(saved));
    } catch (e) {
      // A scanner moved it to `presented` between the read and the write. The
      // approver still gets what they asked for; the transition is retried by
      // their next read, and the decision routes stage it themselves anyway.
      if (e instanceof ConflictError) return c.json(toDetail(projected));
      throw e;
    }
  });

  routes.post("/:ref/approve", requirePrincipal(), decideRoute("approved"));
  routes.post("/:ref/deny", requirePrincipal(), decideRoute("denied"));

  /**
   * Spend the approval, exactly once.
   *
   * The requester's route, because approval and execution are separate events
   * with a gap between them and the gap is where replay lives. The
   * compare-and-set on the version — not the machine's `consume` — is what
   * serializes two executors racing to spend one approval: both read the same
   * version, one write lands, the other is a conflict. An application-level
   * "is it still approved?" check would let both through.
   */
  routes.post("/:ref/consume", requirePrincipal(), async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const now = ctx.clock();
    const row = await loadByRef(ctx, c.req.param("ref") ?? "", now);
    if (!row || !isRequester(ctx, row, principalId)) {
      return fail(c, "interaction_not_found");
    }
    if (row.status === "expired") return fail(c, "interaction_expired");
    // Nothing to spend: still waiting on a person, or refused by one. Not a
    // 404 — the caller is the right caller and the interaction is theirs — and
    // not a conflict either, because what is missing is the ceremony. An
    // authenticated session is not an approval.
    if (
      row.status === "pending" ||
      row.status === "presented" ||
      row.status === "awaiting_approval" ||
      row.status === "denied"
    ) {
      return fail(c, "approval_required");
    }
    if (row.status !== "approved") return fail(c, terminalError(row.status));

    try {
      const spent = interactionMachine.consume(row, now);
      const saved = await ctx.repos.interactions.updateWithVersion(
        row.id,
        row.version,
        { status: spent.status, consumedAt: now },
      );
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "interaction.consumed",
        principalId,
        actorType: "human",
        outcome: "succeeded",
        correlationId: c.get("correlationId"),
        metadata: auditMetadata(saved),
      });
      return c.json(toDetail(saved));
    } catch (e) {
      if (e instanceof ConflictError) return fail(c, "interaction_consumed");
      if (e instanceof DomainError) return fail(c, domainErrorName(e, row));
      throw e;
    }
  });

  /**
   * Withdraw.
   *
   * Either party, because either can change their mind and revoking only ever
   * removes authority — admitting the edge cannot widen anything. Available
   * from `approved` too: between approving and executing there is a window,
   * and a user who reconsiders inside it must be able to close it.
   */
  routes.post("/:ref/revoke", requirePrincipal(), async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const now = ctx.clock();
    const row = await loadByRef(ctx, c.req.param("ref") ?? "", now);
    if (
      !row ||
      !(isApprover(row, principalId) || isRequester(ctx, row, principalId))
    ) {
      return fail(c, "interaction_not_found");
    }
    if (row.status === "expired") return fail(c, "interaction_expired");
    if (interactionMachine.isTerminal(row.status)) {
      return fail(c, terminalError(row.status));
    }

    try {
      const withdrawn = interactionMachine.revoke(row, now);
      const saved = await ctx.repos.interactions.updateWithVersion(
        row.id,
        row.version,
        { status: withdrawn.status, revokedAt: now },
      );
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "interaction.revoked",
        principalId,
        actorType: "human",
        outcome: "succeeded",
        correlationId: c.get("correlationId"),
        metadata: auditMetadata(saved),
      });
      return c.json(toDetail(saved));
    } catch (e) {
      if (e instanceof ConflictError) return fail(c, terminalError(row.status));
      if (e instanceof DomainError) return fail(c, domainErrorName(e, row));
      throw e;
    }
  });

  return routes;
}

/**
 * Allow or refuse, and only with the digest that was on the screen.
 *
 * The echo check is what makes this ceremony mean anything. A valid WebAuthn
 * assertion proves a key was touched and a valid verifiable presentation
 * proves a credential was held; neither says *what was agreed to*. Refusing a
 * decision whose digest is not the stored one is PSD2 dynamic linking
 * (EU 2018/389 RTS Art. 5) generalized past payments, and it is the difference
 * between an approval system and a decorative one.
 *
 * Approval additionally requires the proof's own `boundDigest` to match. The
 * two values come from different parties — the rendering client and the
 * authenticator — and requiring both closes the gap between what a person read
 * and what a credential signed over.
 */
function decideRoute(decision: "approved" | "denied") {
  return async (c: Context<{ Variables: Variables }>) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const invalid = (issues: readonly { path: PropertyKey[] }[]) =>
      c.json(
        {
          error: ERRORS.invalid_request.code,
          fields: invalidFields(issues),
        },
        ERRORS.invalid_request.status,
      );

    // Both decisions carry the same body: the digest echo, and nothing else.
    // A refusal still has to be a refusal of *this* request, and an approval
    // may not hand the server a proof the server has not verified.
    const raw = await c.req.json().catch(() => ({}));
    const echo = DenyInteractionSchema.safeParse(raw);
    if (!echo.success) return invalid(echo.error.issues);

    const now = ctx.clock();
    const row = await loadByRef(ctx, c.req.param("ref") ?? "", now);
    // Only the approver decides. A requester who could settle their own
    // request would make the whole ceremony decorative — and answering 404
    // rather than 403 keeps that from being a way to test whether a reference
    // somebody else holds is live.
    if (!row || !isApprover(row, principalId)) {
      return fail(c, "interaction_not_found");
    }
    if (row.status === "expired") return fail(c, "interaction_expired");
    if (interactionMachine.isTerminal(row.status)) {
      return fail(c, terminalError(row.status));
    }
    if (
      row.requestDigest === undefined ||
      row.requestDigest !== echo.data.requestDigest
    ) {
      // What was shown is not what is stored: refuse rather than consent to
      // something the approver did not read.
      return fail(c, "digest_mismatch");
    }

    // Read from the store, never from the body. This is the one field in the
    // proof with security meaning downstream — a policy that gates on
    // assurance is gating on this — so it has to be the level the approver
    // actually holds.
    const approver = await ctx.repos.principals.getById(principalId);
    const approverAssurance: AssuranceLevel =
      approver?.assurance ?? "provisional";

    try {
      // `approved` is only reachable from `awaiting_approval`, because
      // approving something never put in front of anybody is not a ceremony.
      // The approver's read normally makes that move; staging it here means a
      // client that worked from the inbox listing can still answer, without
      // this route inventing an edge the machine does not have.
      const staged =
        row.status === "awaiting_approval"
          ? row
          : interactionMachine.awaitApproval(row, principalId, now);
      /*
       * The proof records what the *server* established, not what the caller
       * says happened.
       *
       * Everything here is server-side: the mechanism is the one thing this
       * route actually verifies (an authenticated session), the assurance is
       * read from the approver's own principal record, the bound digest is
       * the stored one, and the timestamp comes from the server clock. A
       * client that could name its own mechanism and assurance could write
       * `webauthn` / `phishing_resistant` into an audit trail having touched
       * no key, and an audit row that overstates what was checked is worse
       * than none — it is the row a reviewer believes.
       */
      const settled =
        decision === "approved"
          ? interactionMachine.approve(staged, {
              approverPrincipalId: principalId,
              now,
              proof: {
                mechanism: "session_reauth",
                boundDigest: row.requestDigest ?? "",
                assurance: approverAssurance,
                verifiedAt: now,
              } satisfies ApprovalProof,
            })
          : interactionMachine.deny(staged, principalId, now);

      const saved = await ctx.repos.interactions.updateWithVersion(
        row.id,
        row.version,
        {
          status: settled.status,
          approverPrincipalId: principalId,
          ...(settled.approvalProof
            ? { approvalProof: settled.approvalProof }
            : undefined),
          decidedAt: now,
        },
      );
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType:
          decision === "approved"
            ? "interaction.approved"
            : "interaction.denied",
        principalId,
        actorType: "human",
        outcome: decision === "approved" ? "succeeded" : "denied",
        correlationId: c.get("correlationId"),
        metadata: {
          ...auditMetadata(saved),
          // Both server-derived. Nothing the caller wrote reaches this row:
          // `credentialRef` used to, and it was unverified free text.
          ...(settled.approvalProof
            ? {
                mechanism: settled.approvalProof.mechanism,
                assurance: settled.approvalProof.assurance,
              }
            : undefined),
        },
      });
      return c.json(toDetail(saved));
    } catch (e) {
      // Two approvers racing, or one person double-clicking: the row moved
      // under us. A conflict the caller can act on, not an internal error —
      // and a 500 here would read as "the decision may have landed" when it
      // did not.
      if (e instanceof ConflictError) return fail(c, "interaction_settled");
      if (e instanceof DomainError) return fail(c, domainErrorName(e, row));
      throw e;
    }
  };
}
