import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  readString,
} from "@opensesame/os-domain";
import type {
  InteractionDetail,
  InteractionKind,
  InteractionStatus,
  InteractionSummary,
} from "@opensesame/os-domain";
import {
  InteractionError,
  failure,
  malformed,
  readJsonBody,
} from "./interaction-error.js";
import { isInteractionRef } from "./interaction-url.js";

export {
  InteractionError,
  type InteractionErrorCode,
} from "./interaction-error.js";

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
 * 1. **The digest is echoed, and the client never hands over a proof.**
 *    Approving and denying both carry back the request digest the client was
 *    shown; approving may additionally name an opaque `activationId` the
 *    authority already minted for this interaction, and nothing else. A client
 *    that cannot reproduce the digest it saw cannot answer — which is what
 *    makes an approval an approval *of something* rather than a bare yes, and
 *    what stops a decision computed against one request from settling another
 *    (the same dynamic linking `machines/interaction.ts` enforces
 *    server-side). The client never hands the server an `ApprovalProof`: the
 *    proof is built server-side from what the server actually verified — the
 *    raw assertion the authority checked at `/activation/complete`, recorded
 *    against that `activationId` (`ApproveInteractionSchema` in
 *    `@opensesame/contracts`) — because a client that could name its own
 *    mechanism and assurance could manufacture an audit row for a key it
 *    never touched.
 * 2. **Server prose never becomes an error message.** Failures map to a closed
 *    code union with messages this package owns. A response body is written by
 *    whatever answered the request — which, on a phone that joined the wrong
 *    Wi-Fi, may not be us at all — and rendering it would let a stranger put
 *    words on an approval screen.
 */

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
  /**
   * The fetch the unauthenticated resolve goes through; `fetchImpl` when
   * absent. A surface whose `fetchImpl` attaches a session by itself (Pages'
   * `identityFetch`) passes one that attaches nothing, so scanning a link
   * never sends a credential.
   */
  resolveFetch?: typeof fetch;
}

export interface ApproveInteractionInput {
  /**
   * The digest the client was shown. Echoed so the server can refuse an
   * approval computed against a request that has since changed. No `proof`
   * field: the approval proof is built server-side from what the server
   * verified, never taken from the caller (`ApproveInteractionSchema` in
   * `@opensesame/contracts`).
   */
  requestDigest: string;
  /**
   * The opaque handle for an interaction-scoped activation the authority has
   * already verified (`beginInteractionActivation` then
   * `completeInteractionActivation`). It is not a proof and not a claim about a
   * mechanism — the server reads the mechanism and assurance from the
   * activation record it minted, never from this id. Omitted by a surface that
   * cannot step up, and the server then answers `proof_required`.
   */
  activationId?: string;
}

export interface DenyInteractionInput {
  requestDigest: string;
}

export interface BeginInteractionActivationInput {
  /** The digest the client was shown; the challenge is bound to it server-side. */
  requestDigest: string;
}

/**
 * The interaction-scoped WebAuthn options the authority issued (ADR 0086 §7).
 *
 * `options` is passed through to the surface's own authenticator call
 * unaltered — it is a `PublicKeyCredentialRequestOptionsJSON` whose challenge
 * the server bound to this interaction's digest, and decoding it here would put
 * a second copy of the WebAuthn JSON shape in a transport package. The surface
 * runs `navigator.credentials.get`, then answers with
 * `completeInteractionActivation`.
 */
export interface InteractionActivationChallenge {
  activationId: string;
  options: JsonObject;
  expiresAt: Date;
}

export interface CompleteInteractionActivationInput {
  activationId: string;
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

export interface InteractionActivationResult {
  activationId: string;
  /** The activation lifecycle state, e.g. `activated`. Displayed, never decided on. */
  state: string;
}

export interface InteractionClient {
  resolveInteraction(ref: string): Promise<InteractionSummary>;
  readInteraction(ref: string): Promise<InteractionDetail>;
  /**
   * Begin an interaction-scoped step-up: the authority mints a WebAuthn
   * challenge bound to this interaction's digest and returns it with the
   * activation handle. The surface performs the assertion and answers with
   * `completeInteractionActivation` (ADR 0086 §7 / A-01).
   */
  beginInteractionActivation(
    ref: string,
    input: BeginInteractionActivationInput,
  ): Promise<InteractionActivationChallenge>;
  /**
   * Submit the raw assertion for the authority to verify. Nothing here is a
   * proof the client built — the server checks the assertion against the
   * challenge it issued and records the mechanism itself (A-02).
   */
  completeInteractionActivation(
    ref: string,
    input: CompleteInteractionActivationInput,
  ): Promise<InteractionActivationResult>;
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
  resolveFetch = fetchImpl,
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

  async function send(
    url: string,
    init: RequestInit,
    through: typeof fetch = fetchImpl,
  ): Promise<JsonObject> {
    let res: Response;
    try {
      res = await through(url, init);
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
        await send(
          linkPath(ref),
          {
            method: "GET",
            // Deliberately no bearer: this is the stranger's-camera path, and a
            // client that sent one here would train the endpoint to expect it.
            headers: { accept: "application/json" },
          },
          resolveFetch,
        ),
      );
    },

    async readInteraction(ref) {
      return toDetail(
        await send(path(ref), { method: "GET", headers: authorized() }),
      );
    },

    async beginInteractionActivation(ref, { requestDigest }) {
      // Names the decision so a deny-bound activation can never be minted here
      // and spent as an approve; the server refuses any other decision.
      const body = await send(path(ref, "/activation"), {
        method: "POST",
        headers: { "content-type": "application/json", ...authorized() },
        body: JSON.stringify({ requestDigest, decision: "approved" }),
      });
      const activationId = readString(body.activationId);
      const expiresAt = readDate(body.expiresAt);
      const options = body.options;
      if (
        activationId === undefined ||
        expiresAt === undefined ||
        !isJsonObject(options)
      ) {
        throw malformed();
      }
      return { activationId, options, expiresAt };
    },

    async completeInteractionActivation(ref, input) {
      // The raw assertion, verified server-side. The response carries only the
      // activation handle and its state — never a proof the client could read
      // back and re-assert.
      const body = await send(path(ref, "/activation/complete"), {
        method: "POST",
        headers: { "content-type": "application/json", ...authorized() },
        body: JSON.stringify({
          activationId: input.activationId,
          credentialId: input.credentialId,
          clientDataJSON: input.clientDataJSON,
          authenticatorData: input.authenticatorData,
          signature: input.signature,
        }),
      });
      const activationId = readString(body.activationId);
      const state = readString(body.state);
      if (activationId === undefined || state === undefined) throw malformed();
      return { activationId, state };
    },

    async approveInteraction(ref, { requestDigest, activationId }) {
      // The digest echo, and — at most — the opaque handle for an activation
      // the authority already verified. Never a client-built `ApprovalProof`:
      // the server reads the mechanism and assurance from the activation
      // record it minted, so a body that named them would be asserting a check
      // the server never saw. The step-up that produced the activation
      // happened at `/activation/complete` before this call.
      const body: JsonObject = { requestDigest };
      if (activationId !== undefined) {
        body.activationId = activationId;
      }
      return decide(ref, "/approve", body);
    },

    async denyInteraction(ref, { requestDigest }) {
      // Denial echoes the digest too. Without it a denial cannot be attributed
      // to the request the user actually read, and a receipt that says "denied"
      // without saying what would be worth nothing in a dispute.
      return decide(ref, "/deny", { requestDigest });
    },
  };
}
