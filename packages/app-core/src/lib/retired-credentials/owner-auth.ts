/** Compatible authentication entry points pin authority while loading proof code. */
import {
  assertAuthenticationSession,
  assertNotDecoySession,
} from "../decoy-session.js";
import { kvRefresh } from "../kv.js";
import { retiredCredentialOwnerSeams } from "./owner-policy.js";
export {
  retiredCredentialOwnerSeams,
  retiredCredentialEnrollmentSupported,
} from "./owner-policy.js";

export async function authenticateRetiredCredentialOwner(
  tomb: string,
  password: string,
  refresh = kvRefresh,
): Promise<void> {
  const authorityGeneration = assertNotDecoySession();
  if (!retiredCredentialOwnerSeams.isRealOwner(tomb))
    throw new Error(
      "Unlock the real vault before managing retired credentials.",
    );
  const operation = await import("./owner-operations.js");
  assertNotDecoySession(authorityGeneration);
  if (!retiredCredentialOwnerSeams.isRealOwner(tomb))
    throw new Error("The owner session changed during authentication.");
  return operation.authenticateRetiredCredentialOwner(tomb, password, refresh);
}

/** Password admission proof only. This confers no owner-management permission. */
export async function verifyCurrentCredential(
  tomb: string,
  password: string,
  refresh = kvRefresh,
): Promise<void> {
  const authorityGeneration = assertAuthenticationSession();
  const operation = await import("./owner-operations.js");
  assertAuthenticationSession(authorityGeneration);
  return operation.verifyCurrentCredential(tomb, password, refresh);
}

/** The original owner remains required before loading and before the policy proof. */
export async function withAuthenticatedRetiredCredentialOwner(
  tomb: string,
  password: string,
  commit: () => Promise<void>,
  refresh = kvRefresh,
): Promise<void> {
  const authorityGeneration = assertNotDecoySession();
  const check = () => {
    assertNotDecoySession(authorityGeneration);
    if (!retiredCredentialOwnerSeams.isRealOwner(tomb))
      throw new Error("The owner session changed during authentication.");
  };
  check();
  const operation = await import("./owner-operations.js");
  check();
  return operation.withAuthenticatedRetiredCredentialOwner(
    tomb,
    password,
    commit,
    refresh,
  );
}
