/**
 * Authorization requests addressed to the signed-in person, in Pages (ADR
 * 0046, ADR 0084; ADR 0140 plan step 6): ceremony-kit's client and review
 * bound to app-core's Identity transport and its host authenticator, plus the
 * inbox's rows for Access › Requests.
 *
 * The protocol, the review's order and bindings and the words are
 * ceremony-kit's (`authorization-request-client.ts`, `approval-review.ts`,
 * `approval-copy.ts`, `approval-words.ts`). This module supplies only what differs in Pages:
 *   - the transport: every call goes through `identityFetch` (its bearer,
 *     base and timeouts). There is no anonymous leg — every route here is
 *     the approver's;
 *   - the authenticator: the host's WebAuthn port, the interaction ceremony's
 *     (`hostInteractionAuthenticator`): the authority's options unaltered in,
 *     the raw assertion out;
 *   - the inbox: pending requests as `plane: "hosted"` rows, each saying
 *     what its review will ask for; every row opens that review.
 *
 * The `/approve/:ref` route is `identity.ceremonies`', and the hosted rows
 * are drawn by Access › Requests (plan step 9); the link is read at boot by
 * `approvals-link.ts`. A request id is not a bearer, and no activation,
 * assertion, comparison value or session ever goes in a URL.
 */

import {
  APPROVAL_WORDS,
  ApprovalError,
  type ApprovalReview,
  type AuthorizationRequestClient,
  type AuthorizationRequestView,
  type InteractionAuthenticator,
  assuranceSummary,
  ceremonyPath,
  createApprovalReview,
  createAuthorizationRequestClient,
  describeDetail,
  needsCeremony,
} from "@opensesame/ceremony-kit";
import { currentSession, identityFetch } from "./identity.js";
import { hostInteractionAuthenticator } from "./interactions.js";

export interface ApprovalTransport {
  /** An approver's Identity API call; `path` is relative to the base. */
  fetch(path: string, init: RequestInit): Promise<Response>;
  /** Whether an Identity session is held: nobody else has requests. */
  signedIn(): boolean;
}

/** Pages' Identity transport: the bearer and base every directory call uses. */
export const identityApprovalTransport: ApprovalTransport = {
  fetch: (path, init) => identityFetch(path, init),
  signedIn: () => currentSession() !== null,
};

/** The authorization-request client over a transport. */
export function approvalClient(
  transport: ApprovalTransport = identityApprovalTransport,
): AuthorizationRequestClient {
  return createAuthorizationRequestClient({
    // `identityFetch` attaches the session itself: no bearer here.
    fetchImpl: (path, init) => transport.fetch(path, init),
  });
}

export interface ApprovalBinding {
  transport: ApprovalTransport;
  authenticator: InteractionAuthenticator;
}

const PAGES_BINDING: ApprovalBinding = {
  transport: identityApprovalTransport,
  authenticator: hostInteractionAuthenticator,
};

/** One review for request `id`, bound to Pages unless told otherwise. */
export function approvalReview(
  id: string,
  binding: ApprovalBinding = PAGES_BINDING,
): ApprovalReview {
  return createApprovalReview(
    {
      client: approvalClient(binding.transport),
      authenticator: binding.authenticator,
    },
    id,
  );
}

/**
 * One waiting request as an Access › Requests row.
 *
 * `decide` is the ADR 0084 split: `inline` when the summary asks for nothing
 * beyond a decision, `review` when it asks for a passkey touch or a
 * comparison code — or when the server sent no summary at all. The list
 * settles neither: every row opens `/approve/<ref>` (#512), where the whole
 * request is read and the decision is bound to its digest, verb and policy.
 */
export type HostedRequestRow = {
  plane: "hosted";
  id: string;
  /** The same short string the requester sees. */
  bindingMessage: string;
  /** What approving would let them do, one line per detail. */
  details: string[];
  expiresAt: string;
  /** What the review binds its decision to. */
  requestDigest: string;
  /** The first twelve characters, for a person to compare by eye. */
  digestPrefix: string;
  /** What deciding will take, in words. */
  summary: string;
  decide: "inline" | "review";
  /** The review route for this request, relative to the deployment base. */
  reviewPath: string;
};

export function hostedRequestRow(
  view: AuthorizationRequestView,
): HostedRequestRow {
  const inline = view.assurance !== null && !needsCeremony(view.assurance);
  return {
    plane: "hosted",
    id: view.authReqId,
    bindingMessage: view.bindingMessage,
    details: view.authorizationDetails.map(describeDetail),
    expiresAt: view.expiresAt,
    requestDigest: view.requestDigest,
    digestPrefix: view.requestDigest.slice(0, 12),
    summary: assuranceSummary(view.assurance),
    decide: inline ? "inline" : "review",
    reviewPath: ceremonyPath("approve", { ref: view.authReqId }),
  };
}

export type HostedInbox =
  | { kind: "rows"; rows: HostedRequestRow[] }
  /** No session: these are requests for an account, and a guest has none. */
  | { kind: "signin"; words: string };

/**
 * The pending requests addressed to this session, as rows. Without a session
 * nothing is fetched: an empty list would read as "nothing waiting", which is
 * not what is true.
 */
export async function listHostedRequests(
  transport: ApprovalTransport = identityApprovalTransport,
): Promise<HostedInbox> {
  if (!transport.signedIn()) {
    return { kind: "signin", words: APPROVAL_WORDS.inboxSignIn };
  }
  try {
    const views = await approvalClient(transport).listPending();
    return { kind: "rows", rows: views.map(hostedRequestRow) };
  } catch (error) {
    if (error instanceof ApprovalError && error.kind === "signin") {
      return { kind: "signin", words: APPROVAL_WORDS.inboxSignIn };
    }
    throw error;
  }
}
