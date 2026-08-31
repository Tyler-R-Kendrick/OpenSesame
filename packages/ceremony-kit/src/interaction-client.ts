import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  isJsonObject,
  readString,
} from "@opensesame/os-domain";
import type {
  ApprovalProof,
  InteractionDetail,
  InteractionKind,
  InteractionStatus,
  InteractionSummary,
} from "@opensesame/os-domain";
import { CeremonyRequestError } from "./device.js";
import { isInteractionRef } from "./interaction-url.js";

/**
 * Driving an interaction, once, for every surface (ADR 0086).
 *
 * The four steps of a cross-device ceremony — resolve, read, approve, deny —
 * are identical whether they happen in a phone PWA, the offline Pages vault, a
 * terminal, or an MCP tool. What differs is the origin, the fetch, and where a
 * bearer comes from, so those three are parameters and nothing else is. The
 * module holds no state, reaches for no global, and renders nothing.
 *
 * Two invariants are enforced here rather than left to each caller:
 *
 * 1. **The digest is echoed.** Approving and denying both send back the
 *    request digest the client was shown. A client that cannot reproduce the
 *    digest it saw cannot answer — which is what makes an approval an
 *    approval *of something* rather than a bare yes, and what stops a proof
 *    minted against one request from settling another (the same dynamic
 *    linking `machines/interaction.ts` enforces server-side).
 * 2. **Server prose never becomes an error message.** Failures map to a closed
 *    code union with messages this package owns. A response body is written by
 *    whatever answered the request — which, on a phone that joined the wrong
 *    Wi-Fi, may not be us at all — and rendering it would let a stranger put
 *    words on an approval screen.
 */

/**
 * Every way answering an interaction can fail, as a stable string.
 *
 * A closed union rather than a status code because surfaces branch on meaning:
 * "expired" offers a fresh link, "approval_required" starts sign-in,
 * "digest_mismatch" must scare the user, and `rate_limited` should not.
 * `interaction_unavailable` is the deliberate catch-all — a 500, a proxy error
 * page, an unreachable host and an unparseable body are the same fact to the
 * person holding the phone, and inventing distinctions the client cannot
 * actually verify would only invite callers to trust them.
 */
export type InteractionErrorCode =
  | "interaction_not_found"
  | "interaction_expired"
  | "interaction_revoked"
  | "interaction_consumed"
  | "approval_required"
  | "digest_mismatch"
  | "approval_denied"
  | "rate_limited"
  | "interaction_unavailable";

/**
 * The message shown for each code.
 *
 * Ours, constant, and terse in ADR 0061's voice: what happened, and at most
 * what to do about it. No explanation of the protocol, and — critically — no
 * substitution of anything that arrived over the wire.
 */
const MESSAGES = {
  interaction_not_found: "That request could not be found.",
  interaction_expired: "That request has expired.",
  interaction_revoked: "That request was withdrawn.",
  interaction_consumed: "That request was already used.",
  approval_required: "Sign in to answer this request.",
  digest_mismatch:
    "This request changed since it was shown. Nothing was approved.",
  approval_denied: "That request was already denied.",
  rate_limited: "Too many attempts. Try again shortly.",
  interaction_unavailable:
    "That request could not be answered. Try again shortly.",
} as const satisfies Record<InteractionErrorCode, string>;

const CODES: ReadonlySet<string> = new Set(Object.keys(MESSAGES));

/**
 * A failed interaction call.
 *
 * Extends `CeremonyRequestError` rather than starting a parallel hierarchy:
 * every ceremony surface already catches that type and reads `.status`, so an
 * interaction failure stays catchable by code written before interactions
 * existed, and `.code` is the added precision.
 */
export class InteractionError extends CeremonyRequestError {
  readonly code: InteractionErrorCode;
  constructor(status: number, code: InteractionErrorCode) {
    super(status, MESSAGES[code]);
    this.name = "InteractionError";
    this.code = code;
  }
}

/**
 * HTTP status to code.
 *
 * `410 Gone` covers expiry, revocation and consumption alike — all three are
 * "this existed and is finished" — so it defaults to expiry and is refined by
 * the body. `409` is reserved for the digest check because a digest mismatch
 * is precisely a conflict between what the client was shown and what the
 * server holds. `403` is a decision already recorded against the caller,
 * whereas `401` is the absence of one.
 */
function codeForStatus(status: number): InteractionErrorCode {
  switch (status) {
    case 401:
      return "approval_required";
    case 403:
      return "approval_denied";
    case 404:
      return "interaction_not_found";
    case 409:
      return "digest_mismatch";
    case 410:
      return "interaction_expired";
    case 429:
      return "rate_limited";
    default:
      return "interaction_unavailable";
  }
}

function isErrorCode(value: string): value is InteractionErrorCode {
  return CODES.has(value);
}

async function readJsonBody(res: Response): Promise<JsonObject | null> {
  try {
    const parsed: BoundaryValue = await res.json();
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Turn a failed response into a typed error.
 *
 * The body may *select* one of our codes and may do nothing else: it is read
 * only through `isErrorCode`, so an unrecognised value falls back to the
 * status mapping and an attacker-controlled string can at worst pick a
 * different one of nine sentences we wrote ourselves. Nothing from the
 * response — not the body, not a header, not the reason phrase — reaches the
 * thrown message.
 */
async function failure(res: Response): Promise<InteractionError> {
  const body = await readJsonBody(res);
  const declared =
    body === null ? undefined : readString(body.error ?? body.code);
  if (declared !== undefined && isErrorCode(declared)) {
    return new InteractionError(res.status, declared);
  }
  return new InteractionError(res.status, codeForStatus(res.status));
}

function malformed(): InteractionError {
  // A response we cannot read is indistinguishable, from here, from a captive
  // portal or a middlebox. It is never treated as an approval of anything.
  return new InteractionError(0, "interaction_unavailable");
}

function readDate(value: JsonValue | undefined): Date | undefined {
  const raw = readString(value);
  if (raw === undefined) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function readJsonObjectArray(value: JsonValue | undefined): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is JsonObject => isJsonObject(entry));
}

/**
 * Read the summary fields.
 *
 * `kind` and `status` are carried through as the server sent them rather than
 * checked against the unions in `@opensesame/os-domain`. The server owns that
 * vocabulary, and a client that rejected an unrecognised kind would break
 * every already-installed phone the moment a new ceremony shipped. The cost is
 * bounded: `renderInteractionSummary` has a fallback title, and nothing here
 * branches on the value in a way that grants anything.
 */
function toSummary(body: JsonObject): InteractionSummary {
  const kind = readString(body.kind);
  const status = readString(body.status);
  const expiresAt = readDate(body.expiresAt);
  if (kind === undefined || status === undefined || expiresAt === undefined) {
    throw malformed();
  }
  return {
    /* SAFETY: the server owns the kind vocabulary and this client carries it
       through by contract (see above) — nothing here branches on the value, so
       an unrecognised kind reaches only `renderInteractionSummary`'s fallback
       title. */
    kind: kind as InteractionKind,
    /* SAFETY: the same server-owned contract covers `status`; it is displayed,
       never decided on, so a state this build has not heard of degrades to no
       status line rather than to a wrong one. */
    status: status as InteractionStatus,
    expiresAt,
    requiresApprover: body.requiresApprover === true,
  };
}

/**
 * Read the approver's view.
 *
 * `assuranceRequired` is deliberately not decoded. It drives which
 * authenticator a surface reaches for, and that decision belongs to the
 * surface's own step-up code — decoding the trust vocabulary here would put a
 * second, unvalidated copy of it in a package whose job is transport.
 */
function toDetail(body: JsonObject): InteractionDetail {
  const summary = toSummary(body);
  const id = readString(body.id);
  const createdAt = readDate(body.createdAt);
  if (id === undefined || createdAt === undefined) throw malformed();
  const requesterRef = readString(body.requesterRef);
  const bindingMessage = readString(body.bindingMessage);
  const requestDigest = readString(body.requestDigest);
  const resourceRef = readString(body.resourceRef);
  const decidedAt = readDate(body.decidedAt);
  return {
    ...summary,
    id,
    createdAt,
    authorizationDetails: readJsonObjectArray(body.authorizationDetails),
    ...(requesterRef === undefined ? undefined : { requesterRef }),
    ...(bindingMessage === undefined ? undefined : { bindingMessage }),
    ...(requestDigest === undefined ? undefined : { requestDigest }),
    ...(resourceRef === undefined ? undefined : { resourceRef }),
    ...(decidedAt === undefined ? undefined : { decidedAt }),
  };
}

/**
 * The proof, on the wire.
 *
 * camelCase, matching the Identity API's other bodies — `AuthorizationRequest`
 * responses carry `authReqId`, `bindingMessage` and `requestDigest`, and this
 * envelope is read by the same clients.
 *
 * `verifiedAt` is sent for completeness and is *not* what the server records:
 * the route stamps its own clock, because a client that can move the time an
 * approval was verified can hold one open past its window.
 */
function encodeProof(proof: ApprovalProof): JsonObject {
  return {
    mechanism: proof.mechanism,
    boundDigest: proof.boundDigest,
    assurance: proof.assurance,
    verifiedAt: proof.verifiedAt.toISOString(),
    ...(proof.credentialRef === undefined
      ? undefined
      : { credentialRef: proof.credentialRef }),
  };
}

export interface InteractionClientOptions {
  /** Identity API origin. Build-time for a bundled app, runtime for Pages. */
  baseUrl: string;
  /** The surface's own fetch — timeouts, retries and cookies are its business. */
  fetchImpl: typeof fetch;
  /**
   * The approver's bearer, resolved per call rather than captured, so a
   * surface can return `null` the moment it may no longer hand one out (a
   * locked vault, a signed-out tab) and every later call is unauthenticated.
   */
  bearer?: () => string | null;
}

export interface ApproveInteractionInput {
  /**
   * The digest the client was shown. Echoed so the server can refuse an
   * approval computed against a request that has since changed.
   */
  requestDigest: string;
  proof: ApprovalProof;
}

export interface DenyInteractionInput {
  requestDigest: string;
}

export interface InteractionClient {
  resolveInteraction(ref: string): Promise<InteractionSummary>;
  readInteraction(ref: string): Promise<InteractionDetail>;
  approveInteraction(
    ref: string,
    input: ApproveInteractionInput,
  ): Promise<InteractionDetail>;
  denyInteraction(
    ref: string,
    input: DenyInteractionInput,
  ): Promise<InteractionDetail>;
}

/**
 * Bind the four calls to one origin, one fetch, and one bearer source.
 *
 * `resolveInteraction` never sends the bearer, and that is a design decision
 * rather than an omission: the summary is the view a stranger's camera gets,
 * so the code path that serves it must work — and must be *tested* — without
 * credentials. Sending one anyway would also let the act of scanning tie a
 * session to a link the scanner has not yet agreed to answer.
 */
export function createInteractionClient({
  baseUrl,
  fetchImpl,
  bearer,
}: InteractionClientOptions): InteractionClient {
  const base = baseUrl.replace(/\/+$/, "");

  // A reference goes into a URL path. Validating its shape before it gets
  // there is what stops `../`, a smuggled query, or an encoded slash from
  // turning a ceremony call into a request for some other endpoint.
  function path(ref: string, suffix = ""): string {
    if (!isInteractionRef(ref)) {
      throw new InteractionError(0, "interaction_not_found");
    }
    return `${base}/v1/interactions/${encodeURIComponent(ref)}${suffix}`;
  }

  /**
   * The canonical short link (ADR 0086 §2).
   *
   * The unauthenticated summary lives here rather than under `/v1`, because
   * this is the URL that goes on a screen: it is what a QR encodes and what a
   * wallet pass opens, and resolving it must not require a bearer. The
   * versioned path serves the approver's view instead.
   */
  function linkPath(ref: string): string {
    if (!isInteractionRef(ref)) {
      throw new InteractionError(0, "interaction_not_found");
    }
    return `${base}/i/${encodeURIComponent(ref)}`;
  }

  function authorized(): Record<string, string> {
    const token = bearer?.() ?? null;
    return token === null || token.length === 0
      ? {}
      : { authorization: `Bearer ${token}` };
  }

  async function send(url: string, init: RequestInit): Promise<JsonObject> {
    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch {
      // A transport failure carries a message written by the runtime, often
      // including the full URL. It is dropped rather than wrapped.
      throw malformed();
    }
    if (!res.ok) throw await failure(res);
    const body = await readJsonBody(res);
    if (body === null) throw malformed();
    return body;
  }

  async function decide(
    ref: string,
    suffix: string,
    body: JsonObject,
  ): Promise<InteractionDetail> {
    return toDetail(
      await send(path(ref, suffix), {
        method: "POST",
        headers: { "content-type": "application/json", ...authorized() },
        body: JSON.stringify(body),
      }),
    );
  }

  return {
    async resolveInteraction(ref) {
      return toSummary(
        await send(linkPath(ref), {
          method: "GET",
          // Deliberately no bearer: this is the stranger's-camera path, and a
          // client that sent one here would train the endpoint to expect it.
          headers: { accept: "application/json" },
        }),
      );
    },

    async readInteraction(ref) {
      return toDetail(
        await send(path(ref), { method: "GET", headers: authorized() }),
      );
    },

    async approveInteraction(ref, { requestDigest, proof }) {
      // Refused before the call, not after it. A proof bound to a different
      // digest is not a slow "no" from the server — it is a client that has
      // lost track of what it is approving, and it must not put that on the
      // wire where a lenient endpoint might accept it.
      if (proof.boundDigest !== requestDigest) {
        throw new InteractionError(0, "digest_mismatch");
      }
      return decide(ref, "/approve", {
        requestDigest,
        proof: encodeProof(proof),
      });
    },

    async denyInteraction(ref, { requestDigest }) {
      // Denial echoes the digest too. Without it a denial cannot be attributed
      // to the request the user actually read, and a receipt that says "denied"
      // without saying what would be worth nothing in a dispute.
      return decide(ref, "/deny", { requestDigest });
    },
  };
}
