/** Provider metadata supplies defaults for the common operator-owned OAuth app. */
import type { ConnectPlan, McpInfo, OauthPreset } from "./connect-plan.js";
function emptyMcpPreset(resource: string, docsUrl: string | null): OauthPreset {
  return {
    serverUrl: "",
    authorizationEndpoint: "",
    tokenEndpoint: "",
    revocationEndpoint: null,
    userinfoEndpoint: resource,
    tokenAuth: "none",
    pkce: "S256",
    authorizationParams: {},
    scopes: [],
    refreshTokens: false,
    registration: "manual",
    consoleUrl: null,
    docsUrl,
    templateParams: [],
    verify: null,
    scopeSeparator: " ",
    registrationEndpoint: null,
  };
}
function tokenAuthentication(
  methods: readonly string[],
): OauthPreset["tokenAuth"] {
  if (methods.includes("client_secret_basic")) return "client_secret_basic";
  return methods.includes("client_secret_post") ? "client_secret_post" : "none";
}
function mcpPreset(info: McpInfo, docsUrl: string | null): OauthPreset {
  if (info.status !== "ok") return emptyMcpPreset(info.url, docsUrl);
  return {
    ...emptyMcpPreset(info.resource ?? info.url, docsUrl),
    serverUrl: info.issuer ?? "",
    authorizationEndpoint: info.authorizationEndpoint,
    tokenEndpoint: info.tokenEndpoint,
    revocationEndpoint: info.revocationEndpoint,
    tokenAuth: tokenAuthentication(info.tokenAuthMethods),
    scopes: info.scopes.map((name) => ({
      name,
      description: "Permission advertised by the MCP server.",
      default: false,
    })),
  };
}
export function configuredNativeOAuthPreset(plan: ConnectPlan): {
  preset: OauthPreset;
  resourceParameter?: "send" | "omit";
  protocol?: "mcp";
  endpoint?: string;
  transport?: "sse" | "streamable-http";
} | null {
  if (plan.refused) return null;
  const method = plan.methods.find((entry) => entry.kind === "mcp");
  const mcp = method?.kind === "mcp" ? method.mcp : null;
  const defaults = mcp
    ? {
        endpoint: mcp.url,
        transport: new URL(mcp.url).pathname.endsWith("/sse")
          ? ("sse" as const)
          : ("streamable-http" as const),
      }
    : {};
  const oauth = plan.methods.find((entry) => entry.kind === "oauth");
  // A provider's own OAuth contract is not RFC 8707: it names no `resource`
  // parameter, so none is sent unless its preset says to (an MCP server's is).
  if (oauth?.kind === "oauth" && oauth.preset)
    return {
      preset: oauth.preset,
      resourceParameter: oauth.preset.resourceParameter ?? "omit",
      ...defaults,
    };
  if (!mcp) return null;
  return { preset: mcpPreset(mcp, plan.docsUrl), protocol: "mcp", ...defaults };
}
