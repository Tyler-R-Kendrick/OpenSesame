/**
 * Two verifier handlers, transport-agnostic, for a host to mount.
 *
 * This package is a set of pure functions over bytes; it holds no HTTP
 * framework and knows nothing about the gateway. But the *sequence* — build a
 * request, store its session, project it for a transport; then read a courier's
 * delivery, verify it, and let the session's single-use rule settle — is the
 * same everywhere, and getting the order wrong (verifying before storing,
 * consuming before the digest cross-check) is exactly the class of mistake the
 * rest of the package is written to prevent. So the sequence lives here, once,
 * as {@link beginPresentation} and {@link finishPresentation}, and the caller
 * wires them to whatever transport it has.
 *
 * Neither handler touches `req`/`res`, a router, or a database directly: the
 * session store and trusted-issuer set are injected, `now` is a clock the
 * caller supplies, and the result is data. That is what lets the gateway mount
 * them and the tests drive them with the same code path — see the mount notes
 * in the package README / PR body.
 *
 * What is deliberately *not* here: an approval decision. These handlers verify
 * a presentation and return the evidence; whether that evidence settles an ADR
 * 0086 interaction is the interaction layer's call, made by comparing the
 * returned `boundDigest` against the interaction's own digest. Binding the two
 * is why {@link BeginPresentationInput.approvalBindingDigest} exists.
 */

import type { JsonObject } from "@opensesame/os-domain";
import { type CourierDelivery, readCourierResponse } from "./courier.js";
import type { RequestDigests } from "./digests.js";
import {
  type AuthorizationRequest,
  type AuthorizationRequestInput,
  type DigitalCredentialsRequest,
  authorizationRequestParameters,
  buildAuthorizationRequest,
  digitalCredentialsRequest,
} from "./request.js";
import type { RequestSessionStore } from "./session.js";
import {
  type TrustedIssuer,
  type VerifiedPresentation,
  verifyPresentation,
} from "./verify.js";

/**
 * The injected dependencies a mounted verifier needs.
 *
 * `now` is a function, not a `Date`, so one config serves many requests and a
 * test can drive a deterministic clock. The tolerances default inside
 * `verifyPresentation`; they are surfaced here so a deployment can set them
 * once rather than per call.
 */
export interface VerifierRouteConfig {
  readonly store: RequestSessionStore;
  readonly trustedIssuers: readonly TrustedIssuer[];
  readonly subjectScope?: string | undefined;
  readonly clockSkewSeconds?: number | undefined;
  readonly keyBindingMaxAgeSeconds?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

/** The caller's request, plus the optional approval digest that binds it. */
export type BeginPresentationInput = AuthorizationRequestInput;

/**
 * What {@link beginPresentation} hands back for the caller to render.
 *
 * Exactly one of `parameters` (for `direct_post`, the redirect / `request_uri`
 * form) and `digitalCredentialsRequest` (for `dc_api`) is non-null; the other
 * is null. The three digests are surfaced so the caller can store the protocol
 * digest as its session key and record the operation and approval digests
 * against the interaction it is fronting.
 */
export interface BeginPresentationResult {
  readonly request: AuthorizationRequest;
  readonly state: string;
  readonly digests: RequestDigests;
  readonly parameters: JsonObject | null;
  readonly digitalCredentialsRequest: DigitalCredentialsRequest | null;
}

/**
 * Build a request, persist its session, and project it for its transport.
 *
 * The session is created *before* the projection is returned, so there is no
 * window in which a caller could hand a request to a wallet that the verifier
 * would not later recognize. A duplicate `state` (the store's own guard) throws
 * before anything is rendered.
 */
export async function beginPresentation(
  config: VerifierRouteConfig,
  input: BeginPresentationInput,
): Promise<BeginPresentationResult> {
  const request = buildAuthorizationRequest(input);
  await config.store.create(request);
  const directPost = request.responseMode === "direct_post";
  return {
    request,
    state: request.state,
    digests: request.digests,
    parameters: directPost ? authorizationRequestParameters(request) : null,
    digitalCredentialsRequest: directPost
      ? null
      : digitalCredentialsRequest(request),
  };
}

/**
 * A courier's delivery, plus the protocol digest the caller stored.
 *
 * `expectedRequestDigest` is the protocol digest from
 * {@link BeginPresentationResult.digests}, read back out of the caller's own
 * session state — never off the wire. It is what turns "a response arrived"
 * into "the response to the request I sent".
 */
export interface FinishPresentationInput {
  readonly delivery: CourierDelivery;
  readonly expectedRequestDigest: string;
}

/**
 * Read a courier delivery and verify it, or throw an `Openid4vpError`.
 *
 * `readCourierResponse` fails closed on an encrypted or smuggled-JWE delivery
 * before `verifyPresentation` runs, so an unreadable response never reaches the
 * verifier as if it were cleartext. Everything else is `verifyPresentation`'s
 * contract, unchanged: one response settles one session, and a refusal leaves
 * the session open for a legitimate retry.
 */
export async function finishPresentation(
  config: VerifierRouteConfig,
  input: FinishPresentationInput,
): Promise<VerifiedPresentation> {
  const response = readCourierResponse(input.delivery);
  return await verifyPresentation({
    response,
    store: config.store,
    trustedIssuers: config.trustedIssuers,
    expectedRequestDigest: input.expectedRequestDigest,
    now: config.now?.(),
    clockSkewSeconds: config.clockSkewSeconds,
    keyBindingMaxAgeSeconds: config.keyBindingMaxAgeSeconds,
    subjectScope: config.subjectScope,
  });
}
