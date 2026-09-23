import {
  type LocalAuthorizationRequest,
  localAuthorizationQuery,
  parseLocalAuthorizationRequest,
} from "@opensesame/static-auth";
import {
  type LocalAccessRequest,
  consumeLocalAccessRequest,
  createLocalAccessRequest,
} from "./local-access-requests.js";
import type { LocalApplicationApproval } from "./local-application-approval.js";
import {
  approveLocalAgentApplication,
  approveLocalApplication,
} from "./local-authorization.js";
import { LocalDirectoryError } from "./local-directory.js";
import { localApplicationRequestDigest } from "./local-request-issuance.js";
import type { LocalSession } from "./local-sessions.js";

function canonicalRequest(input: LocalAuthorizationRequest) {
  return parseLocalAuthorizationRequest(localAuthorizationQuery(input));
}

/** Freeze the exact RP transaction, including PKCE, nonce, state and agent key. */
export async function createLocalApplicationRequest(
  tomb: string,
  session: LocalSession,
  input: LocalAuthorizationRequest,
) {
  const request = canonicalRequest(input);
  return createLocalAccessRequest(tomb, session, {
    applicationId: request.applicationId,
    redirectUri: request.redirectUri,
    scopes: request.scopes,
    reason: "Application sign-in",
    authorizationDigest: await localApplicationRequestDigest(request),
  });
}

/** Spend approval once, then issue through the existing private-session/PKCE path.
 * The second fence rechecks both sessions and the exact registration revision.
 * Interruption or issuance failure leaves the request spent, never retryable.
 */
export async function redeemLocalApplicationRequest(
  tomb: string,
  approval: LocalApplicationApproval,
  reference: LocalAccessRequest,
  input: LocalAuthorizationRequest,
) {
  const request = canonicalRequest(input);
  const ref = { ...reference };
  const { session, approver } = approval;
  const authorizationDigest = await localApplicationRequestDigest(request);
  const consumed = await consumeLocalAccessRequest(
    tomb,
    session,
    ref,
    async (row) => {
      if (
        row.authorizationDigest !== authorizationDigest ||
        row.approvingPrincipalId !== (approver ?? session).principalId
      )
        throw new LocalDirectoryError(
          "This approval belongs to another application transaction.",
        );
      return row;
    },
  );
  return approver
    ? approveLocalAgentApplication(tomb, approver, session, request, consumed)
    : approveLocalApplication(tomb, session, request, consumed);
}
