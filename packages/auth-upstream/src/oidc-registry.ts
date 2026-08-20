/**
 * Generic OIDC / OAuth upstream provider registry (Google, GitHub, Entra, mock, …).
 * Concrete token exchange is left to Better Auth social/generic OAuth plugins.
 */
export interface UpstreamOidcProvider {
  id: string;
  displayName: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  /** Discovery document URL; defaults to `{issuer}/.well-known/openid-configuration`. */
  discoveryUrl?: string;
  enabled: boolean;
}

export class UpstreamOidcProviderRegistry {
  private readonly providers = new Map<string, UpstreamOidcProvider>();

  register(provider: UpstreamOidcProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): UpstreamOidcProvider | undefined {
    return this.providers.get(id);
  }

  listEnabled(): UpstreamOidcProvider[] {
    return [...this.providers.values()].filter((p) => p.enabled);
  }

  /** Better Auth `socialProviders` / genericOAuth-compatible view. */
  toBetterAuthSocialConfig() {
    const out = {};
    for (const p of this.listEnabled()) {
      if (!p.clientSecret) continue;
      out[p.id] = {
        clientId: p.clientId,
        clientSecret: p.clientSecret,
        enabled: true,
      };
    }
    return out;
  }
}

/** Seed helper for local mock upstream IdP. */
export function mockUpstreamProvider(
  overrides?: Partial<UpstreamOidcProvider>,
): UpstreamOidcProvider {
  return {
    id: "mock",
    displayName: "Mock Upstream IdP",
    issuer: "http://127.0.0.1:9090",
    clientId: "opensesame-upstream",
    clientSecret: "opensesame-upstream-secret",
    scopes: ["openid", "profile", "email"],
    discoveryUrl: "http://127.0.0.1:9090/.well-known/openid-configuration",
    enabled: true,
    ...overrides,
  };
}
