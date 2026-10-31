/**
 * What a provider's own OAuth contract adds to the one configured-client flow
 * (ADR 0218): the parameters its authorization endpoint requires (Atlassian's
 * `audience`, Notion's `owner`), how it separates scopes, which token types it
 * issues, and the exact request that reads the account behind a token (Notion's
 * version header, Shopify's token header, monday's GraphQL post). All of it
 * comes from the provider's preset, so there is no second list; a provider
 * with no preset (an MCP server) gets the plain contract.
 */
import { connectPlan } from "./connect-plan.js";
import type { ProviderVerification } from "./connect-provider-auth-schema.js";

export type NativeOAuthProviderContract = {
  authorizationParams: Readonly<Record<string, string>>;
  scopeSeparator: " " | ",";
  verify: ProviderVerification | null;
  /** Lower-case token types the provider issues; `bearer` unless its contract names another. */
  tokenTypes: readonly string[];
  /** A token response with no `token_type` at all is the provider's own contract (Shopify). */
  tokenTypeOptional: boolean;
};

const PLAIN: NativeOAuthProviderContract = {
  authorizationParams: {},
  scopeSeparator: " ",
  verify: null,
  tokenTypes: ["bearer"],
  tokenTypeOptional: false,
};

/**
 * Token types a provider documents besides `bearer`. Slack's bot and user
 * tokens are presented as bearer tokens and are issued as `bot` and `user`.
 */
const OTHER_TOKEN_TYPES = new Map<string, readonly string[]>([
  ["slack", ["bot", "user"]],
]);

/**
 * Authorization parameters a preset names that this flow cannot honor. Slack's
 * `user_scope` asks for a second, user token (returned under `authed_user`)
 * this flow neither keeps nor journals, so it is never requested.
 */
const UNMANAGED_PARAMETERS = new Set(["user_scope"]);

/** A provider whose token answer carries no `token_type`: Shopify's offline access token. */
const TOKEN_TYPE_OPTIONAL = new Set(["shopify"]);

export function nativeOAuthProviderContract(
  providerId: string,
): NativeOAuthProviderContract {
  const method = connectPlan(providerId)?.methods.find(
    (entry) => entry.kind === "oauth",
  );
  const preset = method?.kind === "oauth" ? method.preset : null;
  if (!preset) return PLAIN;
  return {
    authorizationParams: Object.fromEntries(
      Object.entries(preset.authorizationParams).filter(
        ([name]) => !UNMANAGED_PARAMETERS.has(name),
      ),
    ),
    scopeSeparator: preset.scopeSeparator,
    verify: preset.verify,
    tokenTypes: ["bearer", ...(OTHER_TOKEN_TYPES.get(providerId) ?? [])],
    tokenTypeOptional: TOKEN_TYPE_OPTIONAL.has(providerId),
  };
}

/** Whether a token answer's `token_type` is one the provider's contract issues. */
export function tokenTypeAdmissible(
  contract: NativeOAuthProviderContract,
  tokenType: string | undefined,
): boolean {
  if (tokenType === undefined) return contract.tokenTypeOptional;
  return contract.tokenTypes.includes(tokenType.toLowerCase());
}

/**
 * The scopes a token answer names: separated by spaces, and by commas only
 * where the provider's contract separates with them, since elsewhere a comma
 * can be part of one scope's name.
 */
export function issuedScopes(
  scope: string,
  separator: NativeOAuthProviderContract["scopeSeparator"] = " ",
): string[] {
  const split = separator === "," ? /[\s,]+/ : /\s+/;
  return [...new Set(scope.split(split).filter(Boolean))];
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a URL is the preset's verify address once its `{placeholders}` are filled in. */
function isVerifyAddress(template: string, url: string): boolean {
  const pattern = template
    .split(/\{[a-z_]+\}/)
    .map(escapeRegExp)
    .join("[A-Za-z0-9.-]+");
  return new RegExp(`^${pattern}$`).test(url);
}

export type NativeOAuthResourceRequest = {
  method: "GET" | "POST";
  headers: Headers;
  body?: string;
};

/**
 * The request that reads the account behind a token. The preset's own request
 * (its method, headers, body and token header) is used only at the address the
 * preset names, with a `{placeholder}` standing for what a person typed (their
 * shop, their tenant): at any other address a configured resource gets the
 * plain bearer read, so a provider's headers do not follow a path they were
 * not written for.
 */
export function nativeOAuthResourceRequest(
  contract: NativeOAuthProviderContract,
  resource: string,
  accessToken: string,
): NativeOAuthResourceRequest {
  const headers = new Headers({ accept: "application/json" });
  const verify = contract.verify;
  if (!verify || !isVerifyAddress(verify.url, resource)) {
    headers.set("authorization", `Bearer ${accessToken}`);
    return { method: "GET", headers };
  }
  for (const [name, value] of Object.entries(verify.headers))
    headers.set(name, value);
  const auth = verify.auth;
  if (auth?.kind === "header")
    headers.set(
      auth.header,
      auth.scheme ? `${auth.scheme} ${accessToken}` : accessToken,
    );
  else headers.set("authorization", `Bearer ${accessToken}`);
  return verify.method === "POST"
    ? { method: "POST", headers, body: verify.body ?? "" }
    : { method: "GET", headers };
}
