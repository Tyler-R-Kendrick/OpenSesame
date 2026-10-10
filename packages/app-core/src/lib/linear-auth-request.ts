/** The actor-specific PKCE request is sealed before the consent window navigates. */
import { readDeviceSecrets } from "./device-connector-records.js";
import {
  LINEAR_PENDING,
  type LinearActor,
  type PendingLinear,
  PendingLinearSchema,
  linearConfiguration,
  linearFingerprint,
  readLinearConnector,
  updateLinearRecord,
} from "./linear-store.js";

function random(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function requested(actor: LinearActor, id: string): string[] {
  const options = linearConfiguration(id).options;
  return [
    ...new Set([
      "read",
      ...options[actor === "app" ? "appScopes" : "userScopes"],
      ...(actor === "app" &&
      readLinearConnector(id)?.recovery?.phase === "cleanup"
        ? ["admin"]
        : []),
    ]),
  ];
}
function authorizationUrl(pending: PendingLinear, challenge: string): string {
  const url = new URL("https://linear.app/oauth/authorize");
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: pending.clientId,
    redirect_uri: pending.redirectUri,
    state: pending.state,
    scope: pending.scopes.join(","),
    actor: pending.actor,
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }))
    url.searchParams.set(name, value);
  return url.href;
}
export async function createLinearAuthorizationRequest(
  id: string,
  actor: LinearActor,
  redirectUri: string,
) {
  const saved = linearConfiguration(id);
  const verifier = random();
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const challenge = btoa(String.fromCharCode(...hash))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const pending: PendingLinear = {
    state: random(),
    verifier,
    clientId: saved.state.oauth.clientId,
    redirectUri,
    actor,
    scopes: requested(actor, id),
    createdAt: Date.now(),
    fingerprint: linearFingerprint(saved.state, saved.options),
  };
  await updateLinearRecord(id, async (record) => {
    const current = linearConfiguration(id);
    if (
      linearFingerprint(current.state, current.options) !== pending.fingerprint
    )
      throw new Error("Linear configuration changed; restart consent");
    return {
      ...record,
      secrets: { ...record.secrets, [LINEAR_PENDING]: JSON.stringify(pending) },
    };
  });
  return { pending, url: authorizationUrl(pending, challenge) };
}
export async function clearLinearAuthorizationRequest(
  id: string,
  state: string,
): Promise<void> {
  if (!readDeviceSecrets()[id]?.[LINEAR_PENDING]) return;
  await updateLinearRecord(id, async (record) => {
    const pending = PendingLinearSchema.safeParse(
      JSON.parse(record.secrets[LINEAR_PENDING] ?? "null"),
    );
    if (!pending.success || pending.data.state !== state) return record;
    const secrets = { ...record.secrets };
    Reflect.deleteProperty(secrets, LINEAR_PENDING);
    return { ...record, secrets };
  });
}
export function linearPopupCallback(search: string, state: string): string {
  const response = new URLSearchParams(search);
  if (
    response.get("native_state") !== state ||
    ["native_state", "native_code", "native_error"].some(
      (key) => response.getAll(key).length > 1,
    ) ||
    response.has("native_code") === response.has("native_error") ||
    (response.get("native_code")?.length ?? 0) > 8192
  )
    throw new Error(
      "This Linear authorization belongs to another sign-in request",
    );
  const callback = new URLSearchParams();
  for (const name of ["state", "code", "error"]) {
    const value = response.get(`native_${name}`);
    if (value !== null) callback.set(`linear_${name}`, value);
  }
  return callback.toString();
}
