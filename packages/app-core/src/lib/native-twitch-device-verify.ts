/** Twitch requires token validation; Helix ties the returned user to that exact client and token. */
import { z } from "zod";
import { nativeApiHttp } from "./native-api-http.js";
import type { IssuedNativeOAuthToken } from "./native-browser-oauth-token.js";
import type {
  NativeConfiguration,
  NativePending,
  NativeRuntime,
} from "./native-connector-schema.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { NativeOAuthError } from "./native-oauth-errors.js";

const identifier = z.string().min(1).max(256);
const Validation = z.object({
  client_id: identifier,
  user_id: identifier,
  login: identifier,
  scopes: z.array(z.string().min(1).max(512)).max(256),
  expires_in: z
    .number()
    .finite()
    .positive()
    .max(365 * 86400),
});
const Users = z.object({
  data: z
    .array(
      z.object({ id: identifier, login: identifier, display_name: identifier }),
    )
    .length(1),
});
export async function verifyNativeTwitchIdentity(
  configuration: NativeConfiguration,
  pending: NativePending,
  token: IssuedNativeOAuthToken,
  transport: NativeProviderTransport,
): Promise<NonNullable<NativeRuntime["identity"]>> {
  const clientId = configuration.clientId;
  if (
    configuration.providerId !== "twitch" ||
    !clientId ||
    pending.clientId !== clientId ||
    !token.protocolValid ||
    !token.scopes
  )
    throw new NativeOAuthError("provider");
  const validated = Validation.safeParse(
    await nativeApiHttp(
      {
        url: "https://id.twitch.tv/oauth2/validate",
        method: "GET",
        headers: new Headers({ authorization: `OAuth ${token.accessToken}` }),
      },
      transport,
    ),
  );
  if (!validated.success || validated.data.client_id !== clientId)
    throw new NativeOAuthError("provider");
  const scopes = validated.data.scopes;
  if (
    pending.scopes.some((scope) => !scopes.includes(scope)) ||
    token.scopes.some((scope) => !scopes.includes(scope)) ||
    scopes.some((scope) => !token.scopes?.includes(scope))
  )
    throw new NativeOAuthError("scope");
  const users = Users.safeParse(
    await nativeApiHttp(
      {
        url: "https://api.twitch.tv/helix/users",
        method: "GET",
        headers: new Headers({
          authorization: `Bearer ${token.accessToken}`,
          "Client-Id": clientId,
        }),
      },
      transport,
    ),
  );
  const account = users.success ? users.data.data[0] : null;
  if (
    !account ||
    account.id !== validated.data.user_id ||
    account.login !== validated.data.login
  )
    throw new NativeOAuthError("provider");
  return {
    id: account.id,
    label: account.display_name,
    kind: "account",
    assurance: "account-verified",
  };
}
