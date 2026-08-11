import { assertSecureUrl, trimSlash } from "./secure-url.js";

export interface ControlPlaneClientConfig {
  baseUrl: string;
  accessToken?: string;
  fetchImpl?: typeof fetch;
}

export function createControlPlaneClient(config: ControlPlaneClientConfig) {
  const base = assertSecureUrl(trimSlash(config.baseUrl), "baseUrl");
  const fetchImpl = config.fetchImpl ?? fetch;

  async function request(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/json");
    if (config.accessToken) {
      headers.set("authorization", `Bearer ${config.accessToken}`);
    }
    if (init?.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return fetchImpl(`${base}${path}`, { ...init, headers });
  }

  return {
    async whoami() {
      const res = await request("/api/v1/principals/me");
      if (!res.ok) throw new Error(`whoami failed: ${res.status}`);
      return res.json();
    },

    async authStatus() {
      if (!config.accessToken) {
        return { authenticated: false as const };
      }
      try {
        const me = await this.whoami();
        return { authenticated: true as const, principal: me };
      } catch {
        return { authenticated: false as const };
      }
    },

    async createTemporaryProject(input: {
      name: string;
      slug?: string;
      ttlSeconds?: number;
    }) {
      const res = await request("/api/v1/projects/temporary", {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(`project create failed: ${res.status}`);
      return res.json();
    },

    async pollClaim(claimId: string, claimToken: string) {
      if (!claimToken.startsWith("osc_clm_")) {
        throw new Error("claimToken required (osc_clm_…)");
      }
      // An id is a path segment, not a path. Interpolated raw, a `../` or a `?`
      // in it aims the request — and the claim token riding along — elsewhere.
      const res = await request(`/api/v1/claims/${encodeURIComponent(claimId)}`, {
        headers: { "x-claim-token": claimToken },
      });
      if (!res.ok) throw new Error(`claim poll failed: ${res.status}`);
      return res.json();
    },

    async registerAnonymousAgent(input: {
      displayName: string;
      publicKeyJkt: string;
      provider?: string;
    }) {
      const res = await request("/api/v1/agents/register", {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(`agent register failed: ${res.status}`);
      return res.json();
    },

    async logout() {
      const res = await request("/api/v1/session/logout", { method: "POST" });
      if (!res.ok && res.status !== 204) {
        throw new Error(`logout failed: ${res.status}`);
      }
    },
  };
}

export type ControlPlaneClient = ReturnType<typeof createControlPlaneClient>;
