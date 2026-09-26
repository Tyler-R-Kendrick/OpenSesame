/**
 * How emulated Connect comes to hold an OAuth client for a connector: the
 * one a person pasted (full configuration), or — for a preset or managed
 * connector — one it registers itself (RFC 7591) or names by a client ID
 * metadata document URL, from what Vercel knows about the service.
 */
import type { ConnectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import {
  type JsonObject,
  type JsonValue,
  readJsonObject,
} from "@opensesame/os-domain";

export type Fetcher = (request: Request) => Promise<Response>;

export const CALLBACK = "https://api.vercel.com/v1/connect/callback";

export type Stored = {
  id: string;
  uid: string;
  name: string;
  service: string;
  type: string;
  connectionMethod?: string;
  /** Created from Vercel's preset (`connectionMethod`) rather than full config. */
  preset: boolean;
  data: JsonObject;
  /** Resolved OAuth client, once registered. */
  oauth?: {
    clientId: string;
    clientSecret: string;
    tokenAuth: string;
    authorize: string;
    token: string;
    pkce: boolean;
    params: Record<string, string>;
  };
};

export type PresetTarget = {
  authorize: string;
  token: string;
  registration: "manual" | "dcr" | "cimd";
  pkce: boolean;
  params: Record<string, string>;
};

/** Authorization parameters as the query string will carry them. */
function queryParams(value: JsonValue | undefined): Record<string, string> {
  const params = readJsonObject(value) ?? {};
  return Object.fromEntries(
    Object.entries(params).map(([key, param]): [string, string] => [
      key,
      String(param),
    ]),
  );
}

/** A full `type: "oauth"` configuration: the client the person pasted. */
function fullConfigClient(stored: Stored): void {
  const data = stored.data;
  const server = readJsonObject(data.serverConfig) ?? {};
  stored.oauth = {
    clientId: String(data.clientId),
    clientSecret: String(data.clientSecret ?? ""),
    tokenAuth: String(data.tokenEndpointAuthMethod ?? "client_secret_post"),
    authorize: String(server.authorization_endpoint),
    token: String(server.token_endpoint),
    pkce: data.codeChallengeMethod === "S256",
    params: queryParams(data.authorizationUrlParams),
  };
}

/** Vercel's own knowledge of the service, for preset and managed rows. */
function presetTarget(plan: ConnectPlan, stored: Stored): PresetTarget | null {
  const oauth = plan.methods.find((m) => m.kind === "oauth");
  const mcp = plan.methods.find((m) => m.kind === "mcp");
  if (
    stored.connectionMethod === "mcp" &&
    mcp?.kind === "mcp" &&
    mcp.mcp.status === "ok"
  ) {
    return {
      authorize: mcp.mcp.authorizationEndpoint,
      token: mcp.mcp.tokenEndpoint,
      registration: mcp.mcp.registration,
      pkce: mcp.mcp.pkce.includes("S256"),
      params: {},
    };
  }
  if (oauth?.kind !== "oauth" || !oauth.preset) return null;
  return {
    authorize: oauth.preset.authorizationEndpoint,
    token: oauth.preset.tokenEndpoint,
    registration: oauth.preset.registration,
    pkce: oauth.preset.pkce !== "none",
    params: oauth.preset.authorizationParams,
  };
}

/** RFC 7591: register Vercel's client at the provider. */
async function register(
  provider: Fetcher,
  target: PresetTarget,
): Promise<string | null> {
  const register = new URL(target.token);
  register.pathname = "/register";
  const reply = await provider(
    new Request(register, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [CALLBACK],
        token_endpoint_auth_method: "none",
        client_name: "Vercel Connect",
      }),
    }),
  );
  if (reply.status !== 201) return null;
  const registered: JsonValue = await reply.json();
  return String(readJsonObject(registered)?.client_id);
}

/** How Vercel ends up with a client for this connector. */
/** The client id Vercel ends up with when the person pasted none. */
async function ownClient(
  provider: Fetcher,
  stored: Stored,
  target: PresetTarget,
): Promise<string> {
  if (target.registration === "cimd") {
    return `https://connect.vercel.com/c/${stored.id}`;
  }
  if (target.registration === "dcr" || stored.type === "managed") {
    return (await register(provider, target)) ?? "";
  }
  return "";
}

export async function resolveClient(
  plan: ConnectPlan,
  provider: Fetcher,
  stored: Stored,
): Promise<string | null> {
  if (!stored.preset && stored.type === "oauth") {
    fullConfigClient(stored);
    return null;
  }
  if (stored.type === "api-key" || stored.connectionMethod === "api-key") {
    return null;
  }
  const target = presetTarget(plan, stored);
  if (!target) return "Vercel publishes no configuration for this service.";
  const pasted = String(stored.data.clientId ?? "");
  const secret = pasted ? String(stored.data.clientSecret ?? "") : "";
  const clientId = pasted || (await ownClient(provider, stored, target));
  if (!clientId)
    return "No client: register one by hand, or registration was refused.";
  stored.oauth = {
    clientId,
    clientSecret: secret,
    tokenAuth: secret ? "client_secret_post" : "none",
    authorize: target.authorize,
    token: target.token,
    pkce: target.pkce,
    params: target.params,
  };
  return null;
}
