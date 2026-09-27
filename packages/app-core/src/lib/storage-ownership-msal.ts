/**
 * Which MSAL cache keys belong to one Entra client id — the app's claim on
 * sessionStorage entries it never writes itself.
 *
 * `@azure/msal-browser` 5.22 with `cacheLocation: "sessionStorage"`
 * (`ambient-auth/entra.ts`) writes these straight to the store, lowercased
 * where noted:
 *
 * - `msal.<clientId>.<name>` — the request in flight (`request.params`,
 *   `code.verifier`, `interaction.status`, …);
 * - `msal.<schema>.token.keys.<clientId>` — the index of its tokens;
 * - `msal.<schema>|<account>|<env>|<type>|<clientId>|<realm>|…` — a token,
 *   lowercased;
 * - `server-telemetry-<clientId>` and `appmetadata-<env>-<clientId>`
 *   (msal-common's `-` separator; `|` is accepted too);
 * - `throttling.<json>` — a request thumbprint whose `clientId` is ours.
 *
 * Not attributable to a client, and so never claimed here: the account
 * records (`msal.<schema>|<account>|<env>|<tenant>`,
 * `msal.<schema>.account.keys`), `msal.version`, `msal.browser.*`, and a
 * family refresh token keyed by family id rather than client id. The reset
 * clears those through the MSAL instance itself when this tab made one
 * (`ambient-auth/entra-instances.ts`).
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";

function thumbprintNames(key: string, clientId: string): boolean {
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(key.slice("throttling.".length));
  } catch {
    return false;
  }
  if (!isJsonObject(parsed)) return false;
  const named = parsed.clientId;
  return isString(named) && named.toLowerCase() === clientId;
}

export function msalKeyNamesClient(key: string, clientId: string): boolean {
  const id = clientId.trim().toLowerCase();
  if (id === "") return false;
  const lower = key.toLowerCase();
  if (lower.startsWith("msal.")) {
    return (
      lower.startsWith(`msal.${id}.`) ||
      (/^msal\.\d+\.token\.keys\./.test(lower) &&
        lower.endsWith(`.token.keys.${id}`)) ||
      lower.split("|").slice(1).includes(id)
    );
  }
  if (/^server-telemetry[-|]/.test(lower)) {
    return lower.slice("server-telemetry-".length) === id;
  }
  if (/^appmetadata[-|]/.test(lower)) {
    return lower.endsWith(`-${id}`) || lower.endsWith(`|${id}`);
  }
  if (key.startsWith("throttling.")) return thumbprintNames(key, id);
  return false;
}
