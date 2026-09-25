/**
 * Cross-device interaction approval in Pages (ADR 0086; ADR 0140 plan step
 * 5): ceremony-kit's approval model bound to app-core's Identity transport,
 * its host authenticator port and its page.
 *
 * The protocol, the phases, the digest and activation binding and the words
 * are ceremony-kit's (`interaction-approval.ts`), shared with mobile-MFA until
 * that app goes. This module supplies only what differs in Pages:
 *   - the transport: the approver's calls go through `identityFetch` (its
 *     bearer, base and timeouts), and resolving the link goes through the
 *     Identity plane with no session and no cookie — scanning is not
 *     approving, so nothing identifying leaves the device on that call;
 *   - the authenticator: the host's WebAuthn port, run against the authority's
 *     options unaltered and answering with the raw assertion only;
 *   - the link: `/i/<ref>` read from the page's address, its fragment and any
 *     legacy code or credential-bearing query taken out before anything else.
 *
 * The route and screen are `identity.ceremonies`' `/i/:ref` (plan step 9).
 * The reference is not a bearer, and no assertion, activation or session
 * ever goes in a URL.
 */

import {
  type InteractionApproval,
  type InteractionAssertion,
  type InteractionAuthenticator,
  type InteractionClient,
  InteractionStepUpError,
  createInteractionApproval,
  createInteractionClient,
} from "@opensesame/ceremony-kit";
import {
  assertionPayload,
  isPublicKeyCredential,
  parsePublicKeyCredentialRequestOptionsJson,
  requestOptionsFromJson,
} from "@opensesame/sdk-browser";
import { credentials, publicKeyCredentialApi } from "../ports.js";
import { identityPlaneRequest } from "./device-identity.js";
import { currentSession, identityFetch } from "./identity.js";

export interface InteractionTransport {
  /** An approver's Identity API call; `path` is relative to the base. */
  fetch(path: string, init: RequestInit): Promise<Response>;
  /** The link's resolve: the same plane, no session, no cookie. */
  anonymous(path: string, init: RequestInit): Promise<Response>;
  /** Whether an Identity session is held to read the approver's view. */
  signedIn(): boolean;
}

/** Pages' Identity transport: the bearer and base every directory call uses. */
export const identityInteractionTransport: InteractionTransport = {
  fetch: (path, init) => identityFetch(path, init),
  anonymous: (path, init) =>
    identityPlaneRequest(path, { ...init, credentials: "omit" }),
  signedIn: () => currentSession() !== null,
};

/** The interaction client over a transport (base-relative paths). */
export function interactionClient(
  transport: InteractionTransport = identityInteractionTransport,
): InteractionClient {
  return createInteractionClient({
    baseUrl: "",
    // `identityFetch` attaches the session itself, so no `bearer` here.
    fetchImpl: (input, init) => transport.fetch(String(input), init ?? {}),
    resolveFetch: (input, init) =>
      transport.anonymous(String(input), init ?? {}),
  });
}

async function getCredential(
  options: CredentialRequestOptions,
): Promise<Credential | null> {
  const container = credentials();
  if (!container) throw new InteractionStepUpError("unavailable");
  try {
    return await container.get(options);
  } catch {
    // A dismissed sheet, a timeout and a refused origin are the same fact
    // here: there is no assertion, and nothing is sent after this.
    throw new InteractionStepUpError("cancelled");
  }
}

function payloadOf(credential: Credential | null): InteractionAssertion {
  if (!credential) throw new InteractionStepUpError("cancelled");
  if (!isPublicKeyCredential(credential)) {
    throw new InteractionStepUpError("invalid_credential");
  }
  try {
    return assertionPayload(credential);
  } catch {
    throw new InteractionStepUpError("invalid_credential");
  }
}

/**
 * The host's platform authenticator. The options are the authority's, with a
 * challenge bound server-side to this request, verb and policy; they are
 * parsed, never altered. What comes back are verification inputs for the
 * authority, not a proof: nothing here names a mechanism or an assurance.
 */
export const hostInteractionAuthenticator: InteractionAuthenticator = {
  available: () =>
    publicKeyCredentialApi() !== undefined && credentials() !== undefined,
  async assert(options) {
    const parsed = parsePublicKeyCredentialRequestOptionsJson(options);
    if (!parsed) throw new InteractionStepUpError("invalid_options");
    return payloadOf(await getCredential(requestOptionsFromJson(parsed)));
  },
};

export interface InteractionBinding {
  transport: InteractionTransport;
  authenticator: InteractionAuthenticator;
}

/** One approval ceremony for `ref`, bound to Pages unless told otherwise. */
export function interactionApproval(
  ref: string,
  binding: InteractionBinding = {
    transport: identityInteractionTransport,
    authenticator: hostInteractionAuthenticator,
  },
): InteractionApproval {
  return createInteractionApproval(
    {
      client: interactionClient(binding.transport),
      authenticator: binding.authenticator,
      signedIn: () => binding.transport.signedIn(),
    },
    ref,
  );
}

export type { InteractionApproval, InteractionAuthenticator };

/** The link is read at boot, apart from the ceremony (`interactions-link.ts`). */
export { captureInteractionLink } from "./interactions-link.js";
