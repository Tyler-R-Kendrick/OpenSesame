import { describe, expect, it } from "vitest";
import type { Connection, Provider } from "./connections.js";
import {
  addPipe,
  buildConnectorReminder,
  connectionVerb,
  firstRunProviders,
  grantReminderToAgent,
  grantableAgentId,
  graphDoors,
  hasConnectorReminder,
  itemMatchesProvider,
  providerVerb,
  unfinishedConnections,
  vaultCreateHref,
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
    callbackUrl: overrides.callbackUrl ?? null,
  };
}

function connection(status: Connection["status"]): Connection {
  return {
    connectionId: "connection_1",
    connectionRef: "conn://org/github/main",
    logicalName: "github/main",
    displayName: "GitHub",
    providerId: "github",
    integrationId: null,
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

  it("treats unconfigured OAuth apps as idle, not install errors", () => {
    expect(providerVerb(provider({ configured: false }), null)).toBe("idle");
    expect(
      providerVerb(
        provider({
          configured: false,
          missingConfig: ["OPENSESAME_CONNECTION_KEY"],
        }),
        null,
      ),
    ).toBe("needs_install");
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

  it("gives each identity-graph door a status and one Fix", () => {
    const login = createItem("login", "Work GitHub");
    if (login.kind === "login") {
      login.uris = [newUri("https://github.com/login")];
    }
    const doors = graphDoors(provider(), [connection("pending")], [login]);
    expect(doors.map((door) => [door.kind, door.action, door.verb])).toEqual([
      ["host", "Fix", "needs_you"],
      ["login", "Open", "connected"],
      ["passkey", "Record metadata", "idle"],
      ["reminder", "Remember", "idle"],
    ]);
    expect(doors[1]?.href).toBe(`/vault/${login.id}`);
    expect(doors[3]?.href).toContain("ref=conn%3A%2F%2Forg%2Fgithub%2Fmain");
  });

  it("prefills a vault login from the provider home", () => {
    expect(vaultCreateHref("login", provider())).toBe(
      "/vault/new/login?name=GitHub&uri=https%3A%2F%2Fgithub.com",
    );
  });

  it("refuses user:demo as a workload identity", () => {
    expect(grantableAgentId("user:demo")).toBeNull();
    expect(grantableAgentId("agt_release_bot")).toBe("agt_release_bot");
  });

  it("adds an agent to a reminder without copying a token", () => {
    const reminder = buildConnectorReminder(provider(), connection("active"));
    const granted = grantReminderToAgent(reminder, "agt_release_bot");
    expect(granted.kind).toBe("secret");
    if (granted.kind === "secret") {
      expect(granted.grantees).toEqual(["agt_release_bot"]);
      expect(granted.value).toBe("");
    }
  });
});
