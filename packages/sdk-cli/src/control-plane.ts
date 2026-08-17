import { assertSecureUrl, trimSlash } from "./secure-url.js";

export interface ControlPlaneClientConfig {
  baseUrl: string;
  accessToken?: string;
  fetchImpl?: typeof fetch;
}

/** `POST /v1/principals/provisional` response (camelCase product API). */
export interface ProvisionalSession {
  principalId: string;
  state: string;
  assurance: string;
  sessionId: string;
  accessToken: string;
  expiresAt: string;
  tokenType: string;
}

// The control plane mounts its product API under /v1 (apps/control-plane/src/app.ts).
// Every path here must be one the server actually serves: a wrong prefix makes each
// ceremony fail with a 404 that reads as a permissions problem.
export function createControlPlaneClient(config: ControlPlaneClientConfig) {
  const base = assertSecureUrl(trimSlash(config.baseUrl), "baseUrl");
  const fetchImpl = config.fetchImpl ?? fetch;
  // A provisional session minted mid-flight (guest bootstrap) must authenticate
  // the calls that follow it within the same client.
  let bearer = config.accessToken;

  async function request(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/json");
    if (bearer) {
      headers.set("authorization", `Bearer ${bearer}`);
    }
    if (init?.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return fetchImpl(`${base}${path}`, { ...init, headers });
  }

  return {
    /**
     * Guest on-ramp: mint an anonymous provisional principal + session.
     * The returned token authenticates this client's subsequent calls.
     */
    async createProvisionalSession(): Promise<ProvisionalSession> {
      const res = await request("/v1/principals/provisional", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        throw new Error(`provisional session failed: ${res.status}`);
      }
      const session = (await res.json()) as ProvisionalSession;
      if (!session.accessToken) {
        throw new Error("provisional session response carried no access token");
      }
      bearer = session.accessToken;
      return session;
    },

    async whoami() {
      const res = await request("/v1/principals/me");
      if (!res.ok) throw new Error(`whoami failed: ${res.status}`);
      return res.json();
    },

    async authStatus() {
      if (!bearer) {
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
      const res = await request("/v1/projects/temporary", {
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
      const res = await request(`/v1/claims/${encodeURIComponent(claimId)}`, {
        headers: { "x-claim-token": claimToken },
      });
      if (!res.ok) throw new Error(`claim poll failed: ${res.status}`);
      return res.json();
    },

    /**
     * Anonymous agent bootstrap. Registration requires a principal, but that
     * principal may itself be provisional: with no token on hand, a guest
     * session is minted first, then the agent is registered under it. The
     * claim session in the response is how a human later takes ownership.
     */
    async registerAnonymousAgent(input: {
      displayName: string;
      publicKeyJkt: string;
      provider?: string;
    }) {
      let provisional: ProvisionalSession | undefined;
      if (!bearer) {
        provisional = await this.createProvisionalSession();
      }
      const res = await request("/v1/agents", {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(`agent register failed: ${res.status}`);
      const registration = (await res.json()) as Record<string, unknown>;
      return provisional ? { ...registration, provisional } : registration;
    },

    /**
     * End a provisional (guest) session server-side. The token alone
     * authenticates, so forgetting it client-side is not enough.
     */
    async logout() {
      if (!bearer) return;
      const res = await request("/v1/principals/provisional/revoke", {
        method: "POST",
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(`logout failed: ${res.status}`);
      }
      bearer = undefined;
    },
  };
}

export type ControlPlaneClient = ReturnType<typeof createControlPlaneClient>;
