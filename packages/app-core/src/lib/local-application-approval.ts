import type { LocalAuthorizationRequest } from "@opensesame/static-auth";
import { readLocalAgentKeys } from "./local-agent-keys.js";
import {
  type LocalApplicationAdmission,
  requireLocalApplicationAdmission,
  withLocalApplicationRequest,
} from "./local-applications.js";
import { LocalDirectoryError, readLocalDirectory } from "./local-directory.js";
import { type LocalSession, withLocalIdentityPair } from "./local-sessions.js";

export type LocalApplicationApproval = {
  session: LocalSession;
  approver?: LocalSession;
};
type Request = Pick<
  LocalAuthorizationRequest,
  "applicationId" | "redirectUri" | "scopes" | "agent"
>;

/** Internal authorization fence shared by approval, redemption and grant use. */
export async function withLocalApplicationApproval<T>(
  tomb: string,
  approval: LocalApplicationApproval,
  request: Request,
  action: (
    admission: LocalApplicationAdmission,
    assertActive: () => void,
  ) => Promise<T>,
): Promise<T> {
  const { session, approver } = approval;
  if (!approver) {
    if (session.authentication !== "passkey" || request.agent) refused();
    return withLocalApplicationRequest(
      tomb,
      session,
      request.applicationId,
      request.redirectUri,
      request.scopes,
      action,
    );
  }
  return withLocalIdentityPair(
    tomb,
    session,
    approver,
    async (agent, human, assertActive, credentialId) => {
      if (
        agent.authentication !== "agent_key" ||
        human.authentication !== "passkey" ||
        agent.principalId === human.principalId
      )
        refused();
      if (request.agent) {
        const keys = await readLocalAgentKeys(tomb);
        if (
          !keys.some(
            (key) =>
              key.principalId === agent.principalId &&
              key.principalId === request.agent?.principalId &&
              key.credentialId === credentialId &&
              key.keyId === request.agent?.keyId,
          )
        )
          refused();
      }
      const admission = await requireLocalApplicationAdmission(
        tomb,
        agent.principalId,
        request.applicationId,
        request.redirectUri,
        request.scopes,
      );
      await requireLocalApplicationAdmission(
        tomb,
        human.principalId,
        request.applicationId,
        request.redirectUri,
        request.scopes,
      );
      const directory = await readLocalDirectory(tomb);
      const member = directory.memberships.find(
        (row) =>
          row.organizationId === admission.organizationId &&
          row.principalId === human.principalId,
      );
      if (!member || (member.role !== "owner" && member.role !== "admin"))
        refused();
      assertActive();
      return action(admission, assertActive);
    },
  );
}

function refused(): never {
  throw new LocalDirectoryError(
    "This application approval is unavailable. Verify the authorized human and agent again.",
  );
}
