/** @vitest-environment jsdom */
import {
  type BoundaryValue,
  type JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  type Delegation,
  type DelegationOffer,
  type RelayRequest,
  type TaskDetail,
  type TaskRun,
  accessSeams,
} from "../lib/access.js";
import { type ConnectionEvent, connectionSeams } from "../lib/connections.js";
import {
  type IdentitySession,
  type Principal,
  identitySeams,
} from "../lib/identity.js";
import { type VaultItem, createItem, newUri } from "../lib/vault/model.js";
import { vaultStore } from "../lib/vault/store.js";
import {
  type PagesWebMcpTool,
  type VaultItemMeta,
  WEBMCP_TOOLS,
  projectVaultItemMeta,
  resetTotpRateLimitForTests,
  webmcpNavigationSeam,
} from "./tools.js";

const SENTINELS = {
  password: "PW-SENTINEL-9f1",
  totpSeed: "JBSWY3DPEHPK3PXP",
  cardNumber: "4111-CARD-SENTINEL",
  cardCode: "CVC-SENTINEL",
  secretValue: "SECRET-VALUE-SENTINEL",
  noteBody: "NOTE-BODY-SENTINEL",
  fieldValue: "FIELD-VALUE-SENTINEL",
  privateKey: "PRIVKEY-SENTINEL",
  bearerToken: "BEARER-SENTINEL",
  keptCopy: "KEPT-COPY-SENTINEL",
} as const;

type MetaView = VaultItemMeta & { healthIssues?: string[] };
type SearchView = { items: MetaView[]; folders: BoundaryValue[] };
type StatusView = {
  vault: string;
  items: number;
  identitySignedIn: boolean;
};
type HealthView = {
  online: boolean;
  hostApi: string;
  host: { health: string };
};
type TotpView = { code: string; secondsRemaining: number };
type IdentityView = { signedIn: boolean };
type SettingsView = { hostApi: string; identityApi: string };

function tool(name: string): PagesWebMcpTool {
  const found = WEBMCP_TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no such tool ${name}`);
  return found;
}

async function run(name: string, args: JsonObject = {}) {
  return await tool(name).execute(args);
}

function requireLogin(itemId: string) {
  const item = vaultStore
    .getSnapshot()
    .items.find((candidate) => candidate.id === itemId);
  if (!item || item.kind !== "login") throw new Error("login fixture missing");
  return item;
}

let loginId = "";
let noteId = "";

beforeAll(async () => {
  await vaultStore.createGuest();

  const login = createItem("login", "GitHub");
  login.username = "octocat";
  login.password = SENTINELS.password;
  login.totp = SENTINELS.totpSeed;
  login.uris = [newUri("https://github.com")];
  login.notes = SENTINELS.noteBody;
  login.fields = [
    { id: "f1", name: "recovery", value: SENTINELS.fieldValue, hidden: true },
  ];
  loginId = login.id;

  const card = createItem("card", "Visa");
  card.number = SENTINELS.cardNumber;
  card.code = SENTINELS.cardCode;
  card.brand = "visa";

  const secret = createItem("secret", "Deploy key");
  secret.value = SENTINELS.secretValue;
  secret.connectionRef = "connection://deploy";

  const note = createItem("note", "Runbook");
  note.notes = SENTINELS.noteBody;
  noteId = note.id;

  const certificate = createItem("certificate", "mTLS leaf");
  certificate.privateKeyPem = SENTINELS.privateKey;
  certificate.commonName = "leaf.example";

  const drop = createItem("drop", "One-time share");
  drop.bearerToken = SENTINELS.bearerToken;
  drop.keptCopy = { kind: "text", text: SENTINELS.keptCopy };

  for (const item of [login, card, secret, note, certificate, drop]) {
    await vaultStore.saveItem(item);
  }
});

const navigateCalls: string[] = [];
const originalNavigate = webmcpNavigationSeam.navigate;
const originalAccessSeams = { ...accessSeams };
const originalConnectionSeams = { ...connectionSeams };
const originalIdentitySeams = { ...identitySeams };

beforeEach(() => {
  navigateCalls.length = 0;
  webmcpNavigationSeam.navigate = (to) => {
    navigateCalls.push(to);
  };
  resetTotpRateLimitForTests();
});

afterEach(() => {
  webmcpNavigationSeam.navigate = originalNavigate;
  Object.assign(accessSeams, originalAccessSeams);
  Object.assign(connectionSeams, originalConnectionSeams);
  Object.assign(identitySeams, originalIdentitySeams);
});

function assertNoSentinels(payload: BoundaryValue): void {
  const text = JSON.stringify(payload);
  for (const [key, sentinel] of Object.entries(SENTINELS)) {
    expect(text, `leaks ${key}`).not.toContain(sentinel);
  }
}

describe("vault metadata projection", () => {
  it("keeps every secret field out of every item kind", () => {
    for (const item of vaultStore.getSnapshot().items) {
      assertNoSentinels(projectVaultItemMeta(item));
    }
  });

  it("is an allowlist: unknown future fields never leak", () => {
    const login = requireLogin(loginId);
    const poisoned: VaultItem = overlapCast({
      ...login,
      futurePassword: "LEAK-SENTINEL",
    });
    expect(JSON.stringify(projectVaultItemMeta(poisoned))).not.toContain(
      "LEAK-SENTINEL",
    );
  });

  it("keeps useful non-secret facts", () => {
    const meta = projectVaultItemMeta(requireLogin(loginId));
    expect(meta.name).toBe("GitHub");
    expect(meta.hasTotp).toBe(true);
    expect(meta.uris).toEqual([{ uri: "https://github.com", match: "domain" }]);
  });
});

describe("opensesame_status / opensesame_health / opensesame_navigate", () => {
  it("summarizes vault state without secrets", async () => {
    identitySeams.currentSession = () => null;
    const raw = await run("opensesame_status");
    const status: StatusView = overlapCast(raw);
    expect(status.vault).toBe("unlocked");
    expect(status.items).toBe(6);
    expect(status.identitySignedIn).toBe(false);
    assertNoSentinels(raw);
  });

  it("reports connectivity posture", async () => {
    const health: HealthView = overlapCast(await run("opensesame_health"));
    expect(health.online).toBe(true);
    expect(health.host.health).toEqual(expect.any(String));
    expect(health.hostApi).toEqual(expect.any(String));
  });

  it("navigates only to known sections", async () => {
    await expect(
      run("opensesame_navigate", { section: "vault" }),
    ).resolves.toEqual({ status: "navigated", location: "/vault" });
    expect(navigateCalls).toEqual(["/vault"]);
    await expect(
      run("opensesame_navigate", { section: "/etc/passwd" }),
    ).rejects.toThrow(/unknown_section/);
  });
});

describe("opensesame_vault_search / opensesame_vault_item_read", () => {
  it("returns metadata with health issues and no secret fields", async () => {
    const raw = await run("opensesame_vault_search");
    const result: SearchView = overlapCast(raw);
    expect(result.items).toHaveLength(6);
    assertNoSentinels(raw);
    const login = result.items.find((item) => item.id === loginId);
    expect(Array.isArray(login?.healthIssues)).toBe(true);
  });

  it("filters by kind, favorites and query", async () => {
    const byKind: SearchView = overlapCast(
      await run("opensesame_vault_search", { kind: "card" }),
    );
    expect(byKind.items.map((item) => item.kind)).toEqual(["card"]);
    const byQuery: SearchView = overlapCast(
      await run("opensesame_vault_search", { query: "github" }),
    );
    expect(byQuery.items.map((item) => item.id)).toEqual([loginId]);
  });

  it("reads a single item's metadata", async () => {
    const raw = await run("opensesame_vault_item_read", { itemId: loginId });
    const meta: MetaView = overlapCast(raw);
    expect(meta.id).toBe(loginId);
    assertNoSentinels(raw);
    await expect(
      run("opensesame_vault_item_read", { itemId: "missing" }),
    ).rejects.toThrow(/item_not_found/);
  });
});

describe("opensesame_vault_item_write", () => {
  it("creates an item with non-secret metadata", async () => {
    const created: MetaView = overlapCast(
      await run("opensesame_vault_item_write", {
        kind: "login",
        name: "Forge",
        url: "https://forge.example",
        favorite: true,
      }),
    );
    expect(created.name).toBe("Forge");
    expect(created.favorite).toBe(true);
    expect(created.uris).toEqual([
      { uri: "https://forge.example", match: "domain" },
    ]);
    const stored = requireLogin(created.id);
    expect(stored.password).toBe("");
    await vaultStore.purgeItem(stored.id);
  });

  it("edits name, favorite and url on an existing login", async () => {
    const edited: MetaView = overlapCast(
      await run("opensesame_vault_item_write", {
        itemId: loginId,
        name: "GitHub (work)",
        url: "https://github.example",
      }),
    );
    expect(edited.name).toBe("GitHub (work)");
    expect(edited.uris).toEqual([
      { uri: "https://github.example", match: "domain" },
    ]);
    const stored = requireLogin(loginId);
    expect(stored.password).toBe(SENTINELS.password);
    expect(stored.totp).toBe(SENTINELS.totpSeed);
  });

  it("rejects secret fields with a clear error", async () => {
    await expect(
      run("opensesame_vault_item_write", {
        itemId: loginId,
        password: "hijack",
        totp: "seed",
      }),
    ).rejects.toThrow(/non_metadata_fields_rejected:password,totp/);
    await expect(
      run("opensesame_vault_item_write", { itemId: noteId, url: "https://x" }),
    ).rejects.toThrow("url_requires_login_item");
  });
});

describe("opensesame_totp_code", () => {
  it("returns the current code and never the seed, rate limited per item", async () => {
    const raw = await run("opensesame_totp_code", { itemId: loginId });
    const first: TotpView = overlapCast(raw);
    expect(first.code).toMatch(/^\d{6}$/);
    expect(first.secondsRemaining).toBeGreaterThan(0);
    assertNoSentinels(raw);
    await expect(
      run("opensesame_totp_code", { itemId: loginId }),
    ).rejects.toThrow("totp_rate_limited");
    resetTotpRateLimitForTests();
    await expect(
      run("opensesame_totp_code", { itemId: loginId }),
    ).resolves.toMatchObject({ code: expect.stringMatching(/^\d{6}$/) });
    await expect(
      run("opensesame_totp_code", { itemId: noteId }),
    ).rejects.toThrow("item_has_no_totp");
  });
});

describe("read tools over the existing lib seams", () => {
  it("opensesame_access_read serves every view through accessSeams", async () => {
    const task: TaskRun = {
      taskRunId: "task-1",
      stateVersion: 3,
      status: "running",
      principalId: "p-1",
    };
    const detail: TaskDetail = {
      ...task,
      capabilityCeiling: null,
      currentCapabilities: null,
    };
    const delegation: Delegation = {
      id: "del-1",
      offerId: "off-1",
      connectionId: "conn-1",
      claimantSubject: "agent:a",
      grantId: "grant-1",
      executionMode: "relay",
      actions: ["read"],
      resources: ["repo:*"],
      expiresAt: "2027-01-01T00:00:00Z",
      revokedAt: null,
    };
    const offer: DelegationOffer = {
      id: "off-1",
      state: "open",
      manifestDigest: "digest",
      expiresAt: "2027-01-01T00:00:00Z",
      items: [],
    };
    const request: RelayRequest = {
      id: "req-1",
      delegationId: "del-1",
      connectionId: "conn-1",
      operation: "issues.create",
      resource: "repo:demo",
      parameters: null,
      requestDigest: "sha256:abc",
      state: "pending",
    };
    const event: ConnectionEvent = {
      id: "ev-1",
      kind: "authorized",
      at: "2026-08-30T00:00:00Z",
      detail: null,
    };
    Object.assign(accessSeams, {
      listTasks: vi.fn(async () => [task]),
      getTask: vi.fn(async () => detail),
      listDelegations: vi.fn(async () => [delegation]),
      listMyOffers: vi.fn(async () => [offer]),
      listRelayRequests: vi.fn(async () => [request]),
    });
    Object.assign(connectionSeams, {
      connectionEvents: vi.fn(async () => [event]),
    });

    await expect(
      run("opensesame_access_read", { view: "tasks" }),
    ).resolves.toEqual({ tasks: [task] });
    await expect(
      run("opensesame_access_read", { view: "task", id: "task-1" }),
    ).resolves.toEqual({ task: detail });
    await expect(
      run("opensesame_access_read", { view: "delegations" }),
    ).resolves.toEqual({ delegations: [delegation] });
    await expect(
      run("opensesame_access_read", { view: "offers" }),
    ).resolves.toEqual({ offers: [offer] });
    await expect(
      run("opensesame_access_read", { view: "relay" }),
    ).resolves.toEqual({ requests: [request] });
    await expect(
      run("opensesame_access_read", { view: "receipts", id: "conn-1" }),
    ).resolves.toEqual({ events: [event] });
    await expect(
      run("opensesame_access_read", { view: "nope" }),
    ).rejects.toThrow();
  });

  it("act tools call the narrow seams only", async () => {
    const terminated: TaskRun = {
      taskRunId: "task-1",
      stateVersion: 4,
      status: "terminated",
      principalId: "p-1",
    };
    const narrowed: Delegation = {
      id: "del-1",
      offerId: "off-1",
      connectionId: "conn-1",
      claimantSubject: "agent:a",
      grantId: "grant-1",
      executionMode: "relay",
      actions: ["read"],
      resources: ["repo:*"],
      expiresAt: "2027-01-01T00:00:00Z",
      revokedAt: null,
    };
    const terminate = vi.fn(async () => terminated);
    const narrow = vi.fn(async () => narrowed);
    const revokeDelegation = vi.fn(async () => {});
    const revokeOffer = vi.fn(async () => {});
    Object.assign(accessSeams, {
      terminateTask: terminate,
      narrowDelegation: narrow,
      revokeDelegation,
      revokeOffer,
    });

    await run("opensesame_task_terminate", {
      taskRunId: "task-1",
      expectedStateVersion: 3,
    });
    expect(terminate).toHaveBeenCalledWith("task-1", 3);

    await run("opensesame_delegation_narrow", {
      delegationId: "del-1",
      actions: ["read"],
      expiresInSeconds: 60,
    });
    expect(narrow).toHaveBeenCalledWith("del-1", {
      actions: ["read"],
      expiresInSeconds: 60,
    });

    await expect(
      run("opensesame_delegation_revoke", { id: "del-1" }),
    ).resolves.toEqual({ status: "revoked", kind: "delegation", id: "del-1" });
    expect(revokeDelegation).toHaveBeenCalledWith("del-1");

    await expect(
      run("opensesame_delegation_revoke", { id: "off-1", kind: "offer" }),
    ).resolves.toEqual({ status: "revoked", kind: "offer", id: "off-1" });
    expect(revokeOffer).toHaveBeenCalledWith("off-1");
  });

  it("opensesame_identity_read projects the principal and never the token", async () => {
    const session: IdentitySession = {
      principalId: "p-1",
      accessToken: "token-abcdef",
      issuerOrigin: "https://id.example",
    };
    const principal: Principal = {
      id: "p-1",
      state: "active",
      assurance: "verified",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      version: 1,
      identities: [
        {
          id: "i-1",
          kind: "oidc",
          issuer: "https://idp.example",
          assurance: "high",
        },
      ],
    };
    identitySeams.currentSession = () => session;
    identitySeams.fetchPrincipal = async () => principal;

    const raw = await run("opensesame_identity_read");
    const result: IdentityView = overlapCast(raw);
    expect(result.signedIn).toBe(true);
    expect(JSON.stringify(raw)).not.toContain("token-abcdef");

    identitySeams.currentSession = () => null;
    await expect(run("opensesame_identity_read")).resolves.toEqual({
      signedIn: false,
    });
  });

  it("opensesame_settings_read omits credential-capable values", async () => {
    const raw = await run("opensesame_settings_read");
    const settings: SettingsView = overlapCast(raw);
    expect(settings.hostApi).toEqual(expect.any(String));
    expect(settings.identityApi).toEqual(expect.any(String));
    expect(JSON.stringify(raw)).not.toContain("tursoUrl");
  });

  it("opensesame_connections_read serves providers/connections/integrations", async () => {
    const listProviders = vi.fn(async () => []);
    const listConnections = vi.fn(async () => []);
    const listIntegrations = vi.fn(async () => []);
    Object.assign(connectionSeams, {
      listProviders,
      listConnections,
      listIntegrations,
    });
    await expect(
      run("opensesame_connections_read", { view: "providers" }),
    ).resolves.toEqual({ providers: [] });
    await expect(
      run("opensesame_connections_read", { view: "connections" }),
    ).resolves.toEqual({ connections: [] });
    await expect(
      run("opensesame_connections_read", { view: "integrations" }),
    ).resolves.toEqual({ integrations: [] });
    expect(listProviders).toHaveBeenCalled();
    expect(listConnections).toHaveBeenCalled();
    expect(listIntegrations).toHaveBeenCalled();
  });
});

describe("ceremony-open tools", () => {
  it("navigate to the ceremony and never decide", async () => {
    const approve = vi.fn();
    Object.assign(accessSeams, { approveRelayRequest: approve });

    await expect(
      run("opensesame_open_relay_approval", { requestId: "req-1" }),
    ).resolves.toEqual({
      status: "ceremony_opened",
      location: "/access?view=requests&request=req-1",
    });
    await expect(
      run("opensesame_open_delegation_claim", {
        claimToken: "tok",
        userCode: "CODE-1",
      }),
    ).resolves.toEqual({
      status: "ceremony_opened",
      location: "/access?view=claim&token=tok&code=CODE-1",
    });
    await expect(
      run("opensesame_open_connect_ceremony", { providerId: "github" }),
    ).resolves.toEqual({
      status: "ceremony_opened",
      location: "/connections/github",
    });
    await expect(
      run("opensesame_open_reveal", { itemId: loginId }),
    ).resolves.toEqual({
      status: "ceremony_opened",
      location: `/vault/${loginId}`,
    });

    expect(navigateCalls).toEqual([
      "/access?view=requests&request=req-1",
      "/access?view=claim&token=tok&code=CODE-1",
      "/connections/github",
      `/vault/${loginId}`,
    ]);
    expect(approve).not.toHaveBeenCalled();
  });
});

describe("locked vault", () => {
  it("refuses vault reads once locked", async () => {
    vaultStore.lock();
    await expect(run("opensesame_vault_search")).rejects.toThrow(
      "vault_locked",
    );
    await expect(
      run("opensesame_totp_code", { itemId: loginId }),
    ).rejects.toThrow("vault_locked");
    const status: StatusView = overlapCast(await run("opensesame_status"));
    expect(status.vault).not.toBe("unlocked");
  });
});
