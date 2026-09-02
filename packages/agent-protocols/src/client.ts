import {
  AGENT_CLAIM_GRANT,
  AGENT_CLAIM_PATH,
  AGENT_IDENTITY_PATH,
  AGENT_REVOKE_PATH,
  AGENT_TOKEN_PATH,
  JWT_BEARER_GRANT,
} from "./constants.js";

export interface AgentAuthClientOptions {
  authorizationServer: string;
  fetch?: typeof fetch;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: "invalid_response", error_description: text.slice(0, 200) };
  }
}

export function createAgentAuthClient(options: AgentAuthClientOptions) {
  const base = options.authorizationServer.replace(/\/+$/u, "");
  const f = options.fetch ?? fetch;

  return {
    async registerAnonymous(): Promise<unknown> {
      const res = await f(`${base}${AGENT_IDENTITY_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "anonymous" }),
      });
      return { status: res.status, body: await readJson(res) };
    },

    async registerServiceAuth(loginHint: string): Promise<unknown> {
      const res = await f(`${base}${AGENT_IDENTITY_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "service_auth", login_hint: loginHint }),
      });
      return { status: res.status, body: await readJson(res) };
    },

    async startClaim(claimToken: string, email?: string): Promise<unknown> {
      const res = await f(`${base}${AGENT_CLAIM_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          claim_token: claimToken,
          ...(email ? { email } : {}),
        }),
      });
      return { status: res.status, body: await readJson(res) };
    },

    async exchangeAssertion(
      assertion: string,
      resource?: string,
    ): Promise<unknown> {
      const body = new URLSearchParams({
        grant_type: JWT_BEARER_GRANT,
        assertion,
      });
      if (resource) body.set("resource", resource);
      const res = await f(`${base}${AGENT_TOKEN_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      return { status: res.status, body: await readJson(res) };
    },

    async pollClaim(claimToken: string): Promise<unknown> {
      const body = new URLSearchParams({
        grant_type: AGENT_CLAIM_GRANT,
        claim_token: claimToken,
      });
      const res = await f(`${base}${AGENT_TOKEN_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      return { status: res.status, body: await readJson(res) };
    },

    async revokeAccessToken(token: string): Promise<unknown> {
      const body = new URLSearchParams({
        token,
        token_type_hint: "access_token",
      });
      const res = await f(`${base}${AGENT_REVOKE_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      return { status: res.status, body: await readJson(res) };
    },
  };
}
