/** Commit only a provider-proven grant; rejected grants are revoked immediately. */
import { type LinearGrant, verifyLinearAccount } from "./linear-api.js";
import { cleanupRejectedLinearGrant } from "./linear-rejected-grant.js";
import {
  type PendingLinear,
  grantKey,
  linearConfiguration,
  linearFingerprint,
  linearPublicRecord,
  updateLinearRecord,
} from "./linear-store.js";
export function checkLinearWorkspace(
  expected: string,
  organization: { id: string; name: string; urlKey: string },
): void {
  const wanted = expected.trim().toLowerCase();
  if (
    wanted &&
    ![organization.id, organization.name, organization.urlKey].some(
      (value) => value.toLowerCase() === wanted,
    )
  )
    throw new Error(
      "The authorized Linear workspace does not match your selection; reconnect and select the correct workspace",
    );
}
export async function saveLinearConsent(
  id: string,
  transaction: PendingLinear,
  grant: LinearGrant,
): Promise<void> {
  try {
    if (!grant.refreshToken)
      throw new Error(
        "Linear did not provide a refresh token; reconnect this account",
      );
    if (transaction.scopes.some((scope) => !grant.scopes.includes(scope)))
      throw new Error(
        "Linear did not grant the requested permissions; reconnect this account",
      );
    const identity = await verifyLinearAccount({
      kind: "oauth",
      token: grant.accessToken,
    });
    checkLinearWorkspace(
      linearConfiguration(id).options.workspace,
      identity.organization,
    );
    await updateLinearRecord(id, async (record, runtime) => {
      const latest = linearConfiguration(id);
      if (
        transaction.actor === "app" &&
        runtime.recovery?.phase === "configure" &&
        !latest.options.appScopes.includes("admin") &&
        grant.scopes.includes("admin")
      )
        throw new Error(
          "Linear retained temporary admin permission; authorize only the configured app scopes",
        );
      if (
        transaction.fingerprint !==
        linearFingerprint(latest.state, latest.options)
      )
        throw new Error("Linear configuration changed during authorization");
      const other = runtime[transaction.actor === "app" ? "user" : "app"];
      if (
        runtime.recovery &&
        runtime.recovery.workspaceId !== identity.organization.id
      )
        throw new Error(
          "Reconnect the original Linear workspace to recover its webhook",
        );
      if (other && other.workspaceId !== identity.organization.id)
        throw new Error(
          "App and user consent must authorize the same Linear workspace",
        );
      return linearPublicRecord(
        {
          ...record,
          secrets: {
            ...record.secrets,
            [grantKey(transaction.actor)]: JSON.stringify({
              kind: "oauth",
              ...grant,
            }),
          },
        },
        {
          ...runtime,
          [transaction.actor]: {
            accountLabel: identity.viewer.name,
            workspaceId: identity.organization.id,
            workspaceName: identity.organization.name,
            workspaceKey: identity.organization.urlKey,
            grantedScopes: grant.scopes,
            expiresAt: grant.expiresAt,
            kind: "oauth",
          },
        },
      );
    });
  } catch (error) {
    try {
      await cleanupRejectedLinearGrant(
        id,
        transaction.actor,
        grant,
        transaction.clientId,
      );
    } catch {
      throw new Error(
        "Linear authorization was not saved and provider cleanup failed. Reconnect or revoke this application in Linear Settings",
      );
    }
    throw error;
  }
}
