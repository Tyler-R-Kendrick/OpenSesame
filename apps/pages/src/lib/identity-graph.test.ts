import { describe, expect, it } from "vitest";
import type { Connection, Provider } from "./connections.js";
import {
  addPipe,
  buildConnectorReminder,
  connectionVerb,
  firstRunProviders,
  hasConnectorReminder,
  itemMatchesProvider,
  providerVerb,
  unfinishedConnections,
  vaultItemsForProvider,
} from "./identity-graph.js";
import { createItem, newUri } from "./vault/model.js";

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "github",
    displayName: "GitHub",
    category: "developer",
    docsUrl: "https://docs.github.com",
    authKind: "oauth2_authorization_code",
    supportsRefresh: true,
    configured: true,
    autoConfigurable: false,
    missingConfig: [],
    scopes: [],
    egress: {
      scheme: "https",
      authorities: ["api.github.com"],
      pathPrefixes: [],
    },
    operations: [],
    ...overrides,
  };
}

function connection(status: Connection["status"]): Connection {
  return {
    connectionId: "connection_1",
    connectionRef: "conn://org/github/main",
    logicalName: "github/main",
    displayName: "GitHub",
    providerId: "github",
    status,
    statusDetail: null,
    organizationId: "org_1",
    projectId: null,
    ownerKind: "organization",
    shareability: "private",
    requestedScopes: [],
    grantedScopes: [],
    accountLabel: null,
    expiresAt: null,
    refreshable: true,
    lastRefreshedAt: null,
    maxInvokeLevel: 2,
    egress: {
      scheme: "https",
      authorities: ["api.github.com"],
      pathPrefixes: [],
    },
    bindings: [],
    createdAt: "2026-08-12T00:00:00Z",
    updatedAt: "2026-08-12T00:00:00Z",
  };
}

describe("identity graph", () => {
  it("splits unfinished connections from healthy and revoked ones", () => {
    const rows = [
      connection("active"),
      connection("pending"),
      connection("needs_reauth"),
      connection("error"),
      connection("revoked"),
    ];
    expect(unfinishedConnections(rows).map((row) => row.status)).toEqual([
      "pending",
      "needs_reauth",
      "error",
    ]);
  });

  it("does not call a missing Host client needs-you", () => {
    expect(providerVerb(provider({ configured: false }), null)).toBe(
      "needs_install",
    );
    expect(connectionVerb("pending")).toBe("needs_you");
    expect(connectionVerb("error")).toBe("broken");
  });

  it("matches vault logins and passkeys to a provider host", () => {
    const login = createItem("login", "Work GitHub");
    if (login.kind === "login") {
      login.uris = [newUri("https://github.com/login")];
    }
    const passkey = createItem("passkey", "GitHub");
    if (passkey.kind === "passkey") passkey.rpId = "github.com";
    const note = createItem("note", "Shopping list");
    expect(itemMatchesProvider(login, provider())).toBe(true);
    expect(itemMatchesProvider(passkey, provider())).toBe(true);
    expect(itemMatchesProvider(note, provider())).toBe(false);
  });

  it("matches a secret by ConnectionRef", () => {
    const secret = createItem("secret", "CI");
    if (secret.kind === "secret") {
      secret.connectionRef = "conn://org/github/main";
    }
    expect(vaultItemsForProvider([secret], provider())).toHaveLength(1);
  });

  it("picks the add pipe from auth kind", () => {
    expect(addPipe(provider())).toBe("oauth");
    expect(addPipe(provider({ authKind: "api_key" }))).toBe("key");
  });

  it("builds a Host reminder that stores the ConnectionRef, not a token", () => {
    const reminder = buildConnectorReminder(provider(), connection("active"));
    expect(reminder.kind).toBe("secret");
    if (reminder.kind === "secret") {
      expect(reminder.connectionRef).toBe("conn://org/github/main");
      expect(reminder.value).toBe("");
    }
    expect(hasConnectorReminder([reminder], connection("active"))).toBe(true);
  });

  it("prefers GitHub, Vercel, and Linear for first-run", () => {
    const picked = firstRunProviders([
      provider({ id: "stripe", displayName: "Stripe" }),
      provider({ id: "linear", displayName: "Linear" }),
      provider({ id: "vercel", displayName: "Vercel" }),
      provider({ id: "github", displayName: "GitHub" }),
    ]);
    expect(picked.map((item) => item.id)).toEqual([
      "github",
      "vercel",
      "linear",
    ]);
  });
});
