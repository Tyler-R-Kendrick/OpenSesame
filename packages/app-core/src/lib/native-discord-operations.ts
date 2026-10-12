/** Guild membership reads use Discord's actual granted user permission. */
import { z } from "zod";
import { nativeApiHttp } from "./native-api-http.js";
import { safeProviderText } from "./native-api-verify.js";
import type { NativeDriverResult } from "./native-connector-drivers.js";
import type { NativeGrant } from "./native-connector-schema.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
export async function listNativeDiscordGuilds(
  grant: NativeGrant,
  transport: NativeProviderTransport,
): Promise<NativeDriverResult> {
  if (
    grant.providerId !== "discord" ||
    grant.kind !== "oauth" ||
    grant.actor !== "user" ||
    grant.issuer !== "https://discord.com" ||
    grant.endpoint !== "https://discord.com/api/oauth2/token"
  )
    throw new NativeOAuthError("provider");
  if (!grant.scopes?.includes("guilds")) throw new NativeOAuthError("scope");
  const rows = z
    .array(
      z.object({
        id: z.string().regex(/^\d{1,32}$/),
        name: z.string().min(1).max(1024),
      }),
    )
    .max(200)
    .parse(
      await nativeApiHttp(
        {
          url: "https://discord.com/api/v10/users/@me/guilds?limit=200",
          method: "GET",
          headers: new Headers({
            authorization: `Bearer ${grant.accessToken}`,
            accept: "application/json",
          }),
        },
        transport,
      ),
    );
  return {
    label: "Discord servers (up to 200)",
    items: rows.map((row) => {
      safeProviderText(row.name, { access: grant.accessToken });
      return {
        id: row.id,
        label: row.name,
        url: `https://discord.com/channels/${row.id}`,
      };
    }),
  };
}
