/** Forgejo public-client PKCE grants can directly access Codeberg's CORS-enabled API. */
import { z } from "zod";
import { nativeApiHttp } from "./native-api-http.js";
import { safeProviderText } from "./native-api-verify.js";
import type { NativeDriverResult } from "./native-connector-drivers.js";
import type { NativeGrant, NativeRuntime } from "./native-connector-schema.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { NativeOAuthError } from "./native-oauth-errors.js";

type Identity = NonNullable<NativeRuntime["identity"]>;
const text = z.string().min(1).max(1024);
const account = z.object({
  id: z.number().int().positive(),
  login: text,
  full_name: z.string().max(1024).optional(),
});
const repositories = z
  .array(
    z.object({
      id: z.number().int().positive(),
      full_name: text,
      html_url: z.string().url().max(4096),
    }),
  )
  .max(100);
function secrets(grant: { accessToken: string; refreshToken?: string }) {
  return { access: grant.accessToken, refresh: grant.refreshToken ?? "" };
}
async function read(
  url: string,
  grant: { accessToken: string },
  transport: NativeProviderTransport,
) {
  return nativeApiHttp(
    {
      url,
      method: "GET",
      headers: new Headers({
        accept: "application/json",
        authorization: `Bearer ${grant.accessToken}`,
      }),
    },
    transport,
  );
}
export async function verifyNativeCodebergIdentity(
  grant: { accessToken: string; refreshToken?: string },
  transport: NativeProviderTransport,
): Promise<Identity> {
  const value = account.parse(
    await read("https://codeberg.org/api/v1/user", grant, transport),
  );
  const label = value.full_name || value.login;
  safeProviderText(value.login, secrets(grant));
  safeProviderText(label, secrets(grant));
  return {
    id: String(value.id),
    label,
    kind: "account",
    assurance: "account-verified",
  };
}
/** A useful provider operation rather than treating local configuration as connection proof. */
export async function listNativeCodebergRepositories(
  grant: NativeGrant,
  transport: NativeProviderTransport,
): Promise<NativeDriverResult> {
  if (
    grant.providerId !== "codeberg" ||
    grant.kind !== "oauth" ||
    grant.actor !== "user" ||
    grant.issuer !== "https://codeberg.org" ||
    grant.endpoint !== "https://codeberg.org/login/oauth/access_token" ||
    (grant.expiresAt !== null && grant.expiresAt <= Date.now())
  )
    throw new NativeOAuthError("provider");
  const rows = repositories.parse(
    await read(
      "https://codeberg.org/api/v1/user/repos?limit=100",
      grant,
      transport,
    ),
  );
  const items = rows.map((row) => {
    const url = new URL(row.html_url);
    if (
      url.origin !== "https://codeberg.org" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new NativeOAuthError("provider");
    safeProviderText(row.full_name, secrets(grant));
    safeProviderText(url.href, secrets(grant));
    return { id: String(row.id), label: row.full_name, url: url.href };
  });
  return { label: "Codeberg repositories (up to 100)", items };
}
