/** Provider credentials leave the sealed record only for a fixed Linear API call. */
import {
  LinearApiError,
  type LinearCredential,
  refreshLinearToken,
} from "./linear-api.js";
import {
  type LinearActor,
  grantKey,
  linearConfiguration,
  linearPublicRecord,
  parseLinearGrant,
  updateLinearRecord,
} from "./linear-store.js";
export async function markLinearReauth(
  id: string,
  actor: LinearActor,
): Promise<void> {
  await updateLinearRecord(id, async (record, runtime) =>
    runtime[actor]
      ? linearPublicRecord(record, {
          ...runtime,
          [actor]: { ...runtime[actor], needsReauth: true },
        })
      : record,
  );
}
export async function linearCredential(
  id: string,
  actor: LinearActor,
): Promise<LinearCredential> {
  let credential: LinearCredential | null = null;
  let failure: Error | null = null;
  await updateLinearRecord(id, async (record, runtime) => {
    const key = grantKey(actor);
    const grant = parseLinearGrant(record.secrets[key]);
    const identity = runtime[actor];
    if (!grant || !identity || identity.needsReauth)
      throw new Error(`Authorize the Linear ${actor} account first`);
    if (
      grant.kind !== "oauth" ||
      (grant.expiresAt !== null && grant.expiresAt > Date.now() + 60_000)
    ) {
      credential = { kind: grant.kind, token: grant.accessToken };
      return record;
    }
    if (!grant.refreshToken)
      throw new Error("Linear authorization expired; reconnect this account");
    const saved = linearConfiguration(id);
    try {
      const refreshed = await refreshLinearToken({
        clientId: saved.state.oauth.clientId,
        refreshToken: grant.refreshToken,
      });
      const next = { ...grant, ...refreshed };
      const needed =
        saved.options[actor === "app" ? "appScopes" : "userScopes"];
      const reduced = needed.some((scope) => !next.scopes.includes(scope));
      if (reduced)
        failure = new Error(
          "Linear permissions changed; reconnect this account",
        );
      else credential = { kind: "oauth", token: next.accessToken };
      return linearPublicRecord(
        {
          ...record,
          secrets: { ...record.secrets, [key]: JSON.stringify(next) },
        },
        {
          ...runtime,
          [actor]: {
            ...identity,
            grantedScopes: next.scopes,
            expiresAt: next.expiresAt,
            needsReauth: reduced,
          },
        },
      );
    } catch (error) {
      if (
        !(error instanceof LinearApiError) ||
        (error.code !== "authorization" && error.oauthError !== "invalid_grant")
      )
        throw error;
      failure = error;
      return linearPublicRecord(record, {
        ...runtime,
        [actor]: { ...identity, needsReauth: true },
      });
    }
  });
  if (failure) throw failure;
  if (!credential) throw new Error("Linear authorization is unavailable");
  return credential;
}
