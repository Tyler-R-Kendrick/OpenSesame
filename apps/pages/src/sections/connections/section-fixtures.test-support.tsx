/**
 * Test fixture: the provider catalog, connection record and router mount the
 * Connections suites render against. Lifted out of
 * `sections/ConnectionsSection.test.tsx` so that suite stays inside the
 * module-size budget (ADR 0093); nothing here mocks a module, so the handles
 * need no `vi.hoisted`.
 */

import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { ConnectionsSection } from "../ConnectionsSection.js";

/** Six bundled providers, one per catalog branch the suites exercise. */
export const CONNECTIONS_CATALOG: Provider[] = (() => {
  const githubProvider: Provider = {
    id: "github",
    displayName: "GitHub",
    category: "developer",
    docsUrl: "https://docs.github.com",
    authKind: "oauth2_authorization_code",
    supportsRefresh: true,
    configured: false,
    autoConfigurable: false,
    missingConfig: ["GITHUB_CLIENT_ID"],
    callbackUrl: null,
    scopes: [
      {
        name: "repo",
        description: "Full repository access",
        sensitive: true,
        default: true,
      },
    ],
    egress: {
      scheme: "https",
      authorities: ["api.github.com"],
      pathPrefixes: [],
    },
    operations: [],
  };

  const linearProvider: Provider = {
    id: "linear",
    displayName: "Linear",
    category: "developer",
    docsUrl: "https://linear.app/docs",
    authKind: "oauth2_authorization_code",
    supportsRefresh: true,
    configured: true,
    autoConfigurable: false,
    missingConfig: [],
    callbackUrl: null,
    scopes: [],
    egress: {
      scheme: "https",
      authorities: ["api.linear.app"],
      pathPrefixes: [],
    },
    operations: [],
  };

  const vercelProvider: Provider = {
    id: "vercel",
    displayName: "Vercel",
    category: "developer",
    docsUrl: "https://vercel.com/docs",
    authKind: "api_key",
    supportsRefresh: false,
    configured: true,
    autoConfigurable: false,
    missingConfig: [],
    callbackUrl: null,
    scopes: [],
    egress: {
      scheme: "https",
      authorities: ["api.vercel.com"],
      pathPrefixes: [],
    },
    operations: [],
  };

  const plainProvider: Provider = {
    id: "plain",
    displayName: "Plain storage",
    category: "local_storage",
    docsUrl: "https://example.com/docs",
    authKind: "configuration",
    supportsRefresh: false,
    configured: true,
    autoConfigurable: true,
    missingConfig: [],
    callbackUrl: null,
    scopes: [],
    egress: { scheme: "https", authorities: [], pathPrefixes: [] },
    operations: [],
  };

  const vaultwardenProvider: Provider = {
    id: "vaultwarden",
    displayName: "Vaultwarden",
    category: "password_managers",
    docsUrl: "https://example.com/vw",
    authKind: "configuration",
    supportsRefresh: false,
    configured: true,
    autoConfigurable: false,
    missingConfig: [],
    callbackUrl: null,
    scopes: [],
    egress: { scheme: "https", authorities: [], pathPrefixes: [] },
    operations: [],
    configurationFields: [
      {
        name: "server_url",
        label: "Server URL",
        secret: false,
        required: true,
      },
      { name: "api_key", label: "API key", secret: true, required: false },
    ],
  };

  const betterAuthProvider: Provider = {
    id: "better-auth",
    displayName: "Better Auth",
    category: "identity",
    docsUrl: "https://better-auth.com/docs/plugins/api-key",
    authKind: "configuration",
    supportsRefresh: false,
    configured: true,
    autoConfigurable: false,
    missingConfig: [],
    callbackUrl: null,
    scopes: [],
    egress: { scheme: "none", authorities: [], pathPrefixes: [] },
    operations: ["identity.configure"],
    configurationFields: [
      { name: "base_url", label: "Base URL", secret: false, required: true },
      { name: "api_key", label: "API key", secret: true, required: true },
      {
        name: "api_key_header",
        label: "API key header",
        secret: false,
        required: true,
      },
      {
        name: "config_id",
        label: "Configuration ID",
        secret: false,
        required: false,
      },
    ],
  };

  return [
    githubProvider,
    linearProvider,
    vercelProvider,
    plainProvider,
    vaultwardenProvider,
    betterAuthProvider,
  ];
})();

export function makeConnection(
  overrides: Partial<Connection> = {},
): Connection {
  return {
    connectionId: "con_1",
    connectionRef: "conn/github/pat",
    logicalName: "github",
    displayName: "GitHub",
    providerId: "github",
    integrationId: null,
    status: "active",
    statusDetail: null,
    organizationId: "org_1",
    projectId: null,
    ownerKind: "user",
    shareability: "private",
    requestedScopes: ["repo"],
    grantedScopes: ["repo"],
    accountLabel: "octocat",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshable: true,
    lastRefreshedAt: null,
    maxInvokeLevel: 2,
    egress: {
      scheme: "https",
      authorities: ["api.github.com"],
      pathPrefixes: [],
    },
    bindings: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

export function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/connections" element={<ConnectionsSection />} />
        <Route
          path="/connections/:providerId"
          element={<ConnectionsSection />}
        />
        <Route
          path="/connections/:providerId/:connectionId"
          element={<ConnectionsSection />}
        />
      </Routes>
    </MemoryRouter>,
  );
}
