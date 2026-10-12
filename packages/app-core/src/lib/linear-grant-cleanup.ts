/** Retry provider cleanup without interpreting an arbitrary failure as revocation. */
import {
  LinearApiError,
  type LinearGrant,
  refreshLinearToken,
  revokeLinearToken,
  verifyLinearAccount,
} from "./linear-api.js";
import type { StoredLinearGrant } from "./linear-store.js";

type RotatedLinearGrant = (grant: LinearGrant) => void | Promise<void>;

function mayAlreadyBeRevoked(error: Error): boolean {
  return error instanceof LinearApiError && [400, 401].includes(error.status);
}

/** A failed revoke is successful only if Linear proves the token cannot authenticate. */
async function revokeAccessToken(token: string): Promise<void> {
  try {
    await revokeLinearToken({ kind: "oauth", token });
  } catch (error) {
    if (!(error instanceof Error) || !mayAlreadyBeRevoked(error)) throw error;
    try {
      await verifyLinearAccount({ kind: "oauth", token });
    } catch (check) {
      if (check instanceof LinearApiError && check.code === "authorization")
        return;
      throw check;
    }
    throw error;
  }
}

async function checkRefreshGrant(
  clientId: string,
  refreshToken: string,
): Promise<LinearGrant | null> {
  try {
    return await refreshLinearToken({ clientId, refreshToken });
  } catch (error) {
    if (error instanceof LinearApiError && error.oauthError === "invalid_grant")
      return null;
    throw error;
  }
}

/** Storage failure still permits immediate cleanup, but never another refresh. */
export async function revokeLinearGrantWithoutRotation(
  grant: LinearGrant,
): Promise<void> {
  let failure: Error | null = null;
  if (grant.refreshToken) {
    try {
      await revokeLinearToken(
        { kind: "oauth", token: grant.refreshToken },
        "refresh_token",
      );
    } catch (error) {
      failure =
        error instanceof Error ? error : new Error("Linear cleanup failed");
    }
  }
  try {
    await revokeAccessToken(grant.accessToken);
  } catch (error) {
    failure =
      error instanceof Error ? error : new Error("Linear cleanup failed");
  }
  if (failure) throw failure;
}

async function journalRotation(
  next: LinearGrant,
  onRotated?: RotatedLinearGrant,
): Promise<void> {
  try {
    await onRotated?.(next);
  } catch (error) {
    try {
      await revokeLinearGrantWithoutRotation(next);
    } catch {
      throw new Error(
        "Linear rotated credentials could not be saved or revoked; revoke this application in Linear Settings",
      );
    }
    throw error;
  }
}

/** Returns whether the original access token was already cleaned up in the retry. */
async function revokeRefreshGrant(
  grant: StoredLinearGrant | LinearGrant,
  clientId: string,
  onRotated?: RotatedLinearGrant,
): Promise<boolean> {
  if (!grant.refreshToken) return false;
  try {
    await revokeLinearToken(
      { kind: "oauth", token: grant.refreshToken },
      "refresh_token",
    );
    return false;
  } catch (error) {
    if (!(error instanceof Error) || !mayAlreadyBeRevoked(error)) throw error;
  }
  const next = await checkRefreshGrant(clientId, grant.refreshToken);
  if (!next) return false;
  // The owner preserves this pair if subsequent cleanup fails, so a rotating
  // provider response never creates an untracked credential during a retry.
  await journalRotation(next, onRotated);
  await revokeAccessToken(grant.accessToken);
  await revokeLinearToken(
    { kind: "oauth", token: next.refreshToken ?? grant.refreshToken },
    "refresh_token",
  );
  await revokeAccessToken(next.accessToken);
  return true;
}

export async function revokeLinearGrant(
  grant: StoredLinearGrant | LinearGrant,
  clientId: string,
  onRotated?: RotatedLinearGrant,
): Promise<void> {
  if ("kind" in grant && grant.kind !== "oauth") return;
  const accessWasCleaned = await revokeRefreshGrant(grant, clientId, onRotated);
  if (!accessWasCleaned) await revokeAccessToken(grant.accessToken);
}
