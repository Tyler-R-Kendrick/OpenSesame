import {
  type JsonObject,
  isBoolean,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import type { WebMcpToolSpec } from "@opensesame/webmcp";
import {
  type NarrowInput,
  getTask,
  listDelegations,
  listMyOffers,
  listRelayRequests,
  listTasks,
  narrowDelegation,
  revokeDelegation,
  revokeOffer,
  terminateTask,
} from "../lib/access.js";
import {
  connectionEvents,
  getConnection,
  listConnections,
  listIntegrations,
  listProviders,
} from "../lib/connections.js";
import {
  type TargetState,
  connectivitySnapshot,
} from "../lib/connectivity-monitor.js";
import { isOnline } from "../lib/connectivity.js";
import {
  currentSession,
  fetchPrincipal,
  hostBase,
  identityBase,
} from "../lib/identity.js";
import { loadSettings } from "../lib/settings.js";
import { buildHealthReport } from "../lib/vault/health.js";
import {
  type DropState,
  type ItemKind,
  type PasskeyCustody,
  type UriMatch,
  type VaultItem,
  activeItems,
  createItem,
  newUri,
  searchMatches,
} from "../lib/vault/model.js";
import { vaultStore } from "../lib/vault/store.js";
import { parseTotp, secondsRemaining, totpCode } from "../lib/vault/totp.js";

/** Mirror of AppShell's SECTIONS paths; the parity test pins them together. */
export const SECTION_PATHS = [
  "/vault",
  "/connections",
  "/access",
  "/identity",
  "/settings",
] as const;

type NavigateFn = (to: string) => void;

const noopNavigate: NavigateFn = () => {};

export type WebMcpNavigationSeam = { navigate: NavigateFn };

/**
 * Router seam: the lifecycle hook binds the live react-router navigate here
 * while the app is mounted. The default is a silent no-op so tools stay
 * callable (and honest about `location`) in environments without the router.
 */
export const webmcpNavigationSeam: WebMcpNavigationSeam = {
  navigate: noopNavigate,
};

export type PagesWebMcpTool = WebMcpToolSpec & {
  capabilityIds: readonly string[];
  scope: "boot" | "session";
};

const ITEM_KINDS: readonly ItemKind[] = [
  "login",
  "passkey",
  "card",
  "secret",
  "note",
  "certificate",
  "drop",
];

function isItemKind(value: string): value is ItemKind {
  return ITEM_KINDS.some((kind) => kind === value);
}

function isSectionPath(value: string): boolean {
  return SECTION_PATHS.some((path) => path === value);
}

function str(args: JsonObject, key: string): string {
  const value = args[key];
  if (!isString(value) || value.length === 0) {
    throw new Error(`missing_argument:${key}`);
  }
  return value;
}

function optStr(args: JsonObject, key: string): string | null {
  const value = args[key];
  return isString(value) && value.length > 0 ? value : null;
}

function requireUnlocked(): void {
  if (vaultStore.getSnapshot().status !== "unlocked") {
    throw new Error("vault_locked");
  }
}

function findItem(itemId: string): VaultItem {
  const item = vaultStore
    .getSnapshot()
    .items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`item_not_found:${itemId}`);
  return item;
}

export type VaultItemUriMeta = { uri: string; match: UriMatch };

export type VaultItemMeta = {
  id: string;
  kind: ItemKind;
  name: string;
  folderId: string | null;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  uris?: VaultItemUriMeta[];
  passwordChangedAt?: string;
  hasTotp?: boolean;
  rpId?: string;
  custody?: PasskeyCustody;
  brand?: string;
  connectionRef?: string;
  commonName?: string;
  serial?: string;
  notAfter?: string;
  state?: DropState;
  expiresAt?: string;
};

/**
 * Allowlist projection of a vault item for agent context. Only the fields
 * named here ever leave the vault over WebMCP — a new model field is absent
 * until deliberately added, which `tools.test.ts` proves with a poisoned
 * fixture. Secret material (passwords, TOTP seeds, card numbers, secret
 * values, private keys, note bodies, custom fields, drop payloads) is never
 * in this projection.
 */
export function projectVaultItemMeta(item: VaultItem): VaultItemMeta {
  const base: VaultItemMeta = {
    id: item.id,
    kind: item.kind,
    name: item.name,
    folderId: item.folderId,
    favorite: item.favorite,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    deletedAt: item.deletedAt,
  };
  switch (item.kind) {
    case "login":
      return {
        ...base,
        uris: item.uris.map((uri) => ({ uri: uri.uri, match: uri.match })),
        passwordChangedAt: item.passwordChangedAt,
        hasTotp: item.totp !== "",
      };
    case "passkey":
      return { ...base, rpId: item.rpId, custody: item.custody ?? "external" };
    case "card":
      return { ...base, brand: item.brand };
    case "secret":
      return { ...base, connectionRef: item.connectionRef };
    case "certificate":
      return {
        ...base,
        commonName: item.commonName,
        serial: item.serial,
        notAfter: item.notAfter,
      };
    case "drop":
      return { ...base, state: item.state, expiresAt: item.expiresAt };
    case "note":
      return base;
  }
}

function healthIssuesById(): Map<string, string[]> {
  const report = buildHealthReport(vaultStore.getSnapshot().items);
  return new Map(
    report.findings.map((finding) => [finding.item.id, [...finding.issues]]),
  );
}

const WRITE_KEYS = new Set([
  "itemId",
  "kind",
  "name",
  "folderId",
  "favorite",
  "url",
]);

function assertMetadataOnlyWrite(args: JsonObject): void {
  const rejected = Object.keys(args).filter((key) => !WRITE_KEYS.has(key));
  if (rejected.length > 0) {
    throw new Error(
      `non_metadata_fields_rejected:${rejected.sort().join(",")} — WebMCP writes carry title, folder, favorite and url only; secret fields stay in the vault UI`,
    );
  }
}

export const TOTP_RATE_LIMIT_MS = 2000;
const totpLastIssuedAt = new Map<string, number>();

export function resetTotpRateLimitForTests(): void {
  totpLastIssuedAt.clear();
}

function ceremonyOpened(location: string) {
  webmcpNavigationSeam.navigate(location);
  return { status: "ceremony_opened", location } as const;
}

function targetSummary(state: TargetState) {
  return {
    health: state.health,
    rttMs: state.rttMs,
    lastCheckedAt: state.lastCheckedAt,
  } as const;
}

export const WEBMCP_TOOLS: readonly PagesWebMcpTool[] = [
  {
    name: "opensesame_status",
    capabilityIds: ["host.whoami", "app.status"],
    scope: "boot",
    description:
      "Vault and session status for the OpenSesame authority vault: lock state, item and folder counts, storage durability, and whether an identity session is active. Never returns secret material.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: () => {
      const snapshot = vaultStore.getSnapshot();
      const live = activeItems(snapshot.items);
      return {
        vault: snapshot.status,
        durable: snapshot.durable,
        items: live.length,
        trashed: snapshot.items.length - live.length,
        folders: snapshot.folders.length,
        identitySignedIn: currentSession() !== null,
        sections: [...SECTION_PATHS],
      };
    },
  },
  {
    name: "opensesame_navigate",
    capabilityIds: ["app.navigate"],
    scope: "boot",
    description:
      "Navigate the vault app to a section: /vault, /connections, /access, /identity or /settings.",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: [...SECTION_PATHS],
          description: "Section path to open.",
        },
      },
      required: ["section"],
      additionalProperties: false,
    },
    execute: (args) => {
      const raw = str(args, "section");
      const section = raw.startsWith("/") ? raw : `/${raw}`;
      if (!isSectionPath(section)) {
        throw new Error(
          `unknown_section:${section} — sections are ${SECTION_PATHS.join(", ")}`,
        );
      }
      webmcpNavigationSeam.navigate(section);
      return { status: "navigated", location: section };
    },
  },
  {
    name: "opensesame_health",
    capabilityIds: ["host.health.pages"],
    scope: "boot",
    description:
      "Connectivity posture of this vault tab: browser online state and last-probed health of the Host API, Identity API and local machine agent.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: () => {
      const snapshot = connectivitySnapshot();
      return {
        online: isOnline(),
        offline: snapshot.offline,
        hostApi: hostBase(),
        identityApi: identityBase(),
        host: targetSummary(snapshot.host),
        identity: targetSummary(snapshot.identity),
        machine: targetSummary(snapshot.machine),
      };
    },
  },
  {
    name: "opensesame_vault_search",
    capabilityIds: ["vault.items.search"],
    scope: "session",
    description:
      "Search vault items by text, kind, folder or favorites. Returns metadata only (names, kinds, folders, flags, timestamps, health issues) — never passwords, seeds or other secret fields.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text match." },
        kind: { type: "string", enum: [...ITEM_KINDS] },
        folderId: { type: "string" },
        favorites: { type: "boolean" },
      },
      additionalProperties: false,
    },
    execute: (args) => {
      requireUnlocked();
      const query = optStr(args, "query");
      const kind = optStr(args, "kind");
      const folderId = optStr(args, "folderId");
      const favorites = args.favorites === true;
      if (kind && !isItemKind(kind)) {
        throw new Error(`unknown_kind:${kind}`);
      }
      const issues = healthIssuesById();
      const items = activeItems(vaultStore.getSnapshot().items)
        .filter((item) => (kind ? item.kind === kind : true))
        .filter((item) => (folderId ? item.folderId === folderId : true))
        .filter((item) => (favorites ? item.favorite : true))
        .filter((item) => (query ? searchMatches(item, query) : true))
        .map((item) => ({
          ...projectVaultItemMeta(item),
          healthIssues: issues.get(item.id) ?? [],
        }));
      return { items, folders: vaultStore.getSnapshot().folders };
    },
  },
  {
    name: "opensesame_vault_item_read",
    capabilityIds: ["vault.items.read_meta"],
    scope: "session",
    description:
      "Read one vault item's metadata by id: name, kind, folder, flags, timestamps and health issues. Secret fields are never included; use opensesame_open_reveal to hand a reveal to the human.",
    inputSchema: {
      type: "object",
      properties: { itemId: { type: "string" } },
      required: ["itemId"],
      additionalProperties: false,
    },
    execute: (args) => {
      requireUnlocked();
      const item = findItem(str(args, "itemId"));
      return {
        ...projectVaultItemMeta(item),
        healthIssues: healthIssuesById().get(item.id) ?? [],
      };
    },
  },
  {
    name: "opensesame_vault_item_write",
    capabilityIds: ["vault.items.write_meta"],
    scope: "session",
    description:
      "Create a vault item or edit non-secret metadata (name, folder, favorite, url) on an existing one. Any attempt to write secret fields is rejected — credential entry stays in the vault UI.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: {
          type: "string",
          description: "Existing item to edit; omit to create.",
        },
        kind: {
          type: "string",
          enum: [...ITEM_KINDS],
          description: "Required when creating.",
        },
        name: { type: "string" },
        folderId: { type: "string" },
        favorite: { type: "boolean" },
        url: { type: "string", description: "Login items only." },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      requireUnlocked();
      assertMetadataOnlyWrite(args);
      const itemId = optStr(args, "itemId");
      const name = optStr(args, "name");
      const folderId = optStr(args, "folderId");
      const url = optStr(args, "url");
      const favorite = isBoolean(args.favorite) ? args.favorite : null;

      let item: VaultItem;
      if (itemId) {
        item = { ...findItem(itemId) };
      } else {
        const kind = str(args, "kind");
        if (!isItemKind(kind)) {
          throw new Error(`unknown_kind:${kind}`);
        }
        if (!name) throw new Error("missing_argument:name");
        item = createItem(kind, name);
      }
      if (name) item.name = name;
      if (folderId !== null) item.folderId = folderId;
      if (favorite !== null) item.favorite = favorite;
      if (url !== null) {
        if (item.kind !== "login") {
          throw new Error("url_requires_login_item");
        }
        const [first, ...rest] = item.uris;
        item.uris = first ? [{ ...first, uri: url }, ...rest] : [newUri(url)];
      }
      await vaultStore.saveItem(item);
      return projectVaultItemMeta(findItem(item.id));
    },
  },
  {
    name: "opensesame_totp_code",
    capabilityIds: ["vault.totp.code"],
    scope: "session",
    description:
      "Current TOTP code for a login item that has an authenticator secret, with seconds remaining in the period. The seed itself never leaves the vault; per-item rate limited.",
    inputSchema: {
      type: "object",
      properties: { itemId: { type: "string" } },
      required: ["itemId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      requireUnlocked();
      const item = findItem(str(args, "itemId"));
      if (item.kind !== "login" || item.totp === "") {
        throw new Error("item_has_no_totp");
      }
      const now = Date.now();
      const last = totpLastIssuedAt.get(item.id) ?? 0;
      if (now - last < TOTP_RATE_LIMIT_MS) {
        throw new Error("totp_rate_limited");
      }
      totpLastIssuedAt.set(item.id, now);
      const config = parseTotp(item.totp);
      const code = await totpCode(config);
      return {
        itemId: item.id,
        code,
        secondsRemaining: secondsRemaining(config.period),
        period: config.period,
      };
    },
  },
  {
    name: "opensesame_connections_read",
    capabilityIds: [
      "providers.list",
      "connections.list",
      "connections.inspect",
      "integrations.read",
    ],
    scope: "session",
    description:
      "Read the Host connection plane: provider catalog, connections, one connection with its activity events, or configured integrations. Read-only; never returns credentials.",
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["providers", "connections", "connection", "integrations"],
        },
        connectionId: {
          type: "string",
          description: "Required for the connection view.",
        },
      },
      required: ["view"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const view = str(args, "view");
      switch (view) {
        case "providers":
          return { providers: await listProviders() };
        case "connections":
          return { connections: await listConnections() };
        case "connection": {
          const id = str(args, "connectionId");
          const [connection, events] = await Promise.all([
            getConnection(id),
            connectionEvents(id),
          ]);
          return { connection, events };
        }
        case "integrations":
          return { integrations: await listIntegrations() };
        default:
          throw new Error(`unknown_view:${view}`);
      }
    },
  },
  {
    name: "opensesame_access_read",
    capabilityIds: [
      "tasks.list",
      "tasks.inspect",
      "receipts.read",
      "delegations.list",
      "delegations.offers.list",
      "relay.inbox",
      "agent_identities.read",
    ],
    scope: "session",
    description:
      "Read the access plane: task runs, one task with its capability ceiling, delegations, the caller's delegation offers, the relay approval inbox, or a connection's receipts. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["tasks", "task", "delegations", "offers", "relay", "receipts"],
        },
        id: {
          type: "string",
          description:
            "Task run id for view=task; connection id for view=receipts.",
        },
      },
      required: ["view"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const view = str(args, "view");
      switch (view) {
        case "tasks":
          return { tasks: await listTasks() };
        case "task":
          return { task: await getTask(str(args, "id")) };
        case "delegations":
          return { delegations: await listDelegations() };
        case "offers":
          return { offers: await listMyOffers() };
        case "relay":
          return { requests: await listRelayRequests() };
        case "receipts":
          return { events: await connectionEvents(str(args, "id")) };
        default:
          throw new Error(`unknown_view:${view}`);
      }
    },
  },
  {
    name: "opensesame_task_terminate",
    capabilityIds: ["tasks.terminate"],
    scope: "session",
    description:
      "Terminate a task-scoped authority run by id, optionally guarded by the expected state version.",
    inputSchema: {
      type: "object",
      properties: {
        taskRunId: { type: "string" },
        expectedStateVersion: { type: "number" },
      },
      required: ["taskRunId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const id = str(args, "taskRunId");
      const version = isNumber(args.expectedStateVersion)
        ? args.expectedStateVersion
        : undefined;
      return { task: await terminateTask(id, version) };
    },
  },
  {
    name: "opensesame_delegation_narrow",
    capabilityIds: ["delegations.narrow"],
    scope: "session",
    description:
      "Narrow a delegation — restriction only. Omitted fields stay as granted; nothing can widen.",
    inputSchema: {
      type: "object",
      properties: {
        delegationId: { type: "string" },
        actions: { type: "array", items: { type: "string" } },
        resources: { type: "array", items: { type: "string" } },
        expiresInSeconds: { type: "number" },
      },
      required: ["delegationId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const id = str(args, "delegationId");
      const input: NarrowInput = {};
      if (Array.isArray(args.actions)) {
        input.actions = args.actions.filter(isString);
      }
      if (Array.isArray(args.resources)) {
        input.resources = args.resources.filter(isString);
      }
      if (isNumber(args.expiresInSeconds)) {
        input.expiresInSeconds = args.expiresInSeconds;
      }
      return { delegation: await narrowDelegation(id, input) };
    },
  },
  {
    name: "opensesame_delegation_revoke",
    capabilityIds: ["delegations.revoke", "delegations.offers.revoke"],
    scope: "session",
    description:
      "Revoke a delegation, or an unclaimed delegation offer with kind=offer.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        kind: { type: "string", enum: ["delegation", "offer"] },
      },
      required: ["id"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const id = str(args, "id");
      const kind = optStr(args, "kind") ?? "delegation";
      if (kind === "offer") {
        await revokeOffer(id);
        return { status: "revoked", kind: "offer", id };
      }
      if (kind !== "delegation") throw new Error(`unknown_kind:${kind}`);
      await revokeDelegation(id);
      return { status: "revoked", kind: "delegation", id };
    },
  },
  {
    name: "opensesame_identity_read",
    capabilityIds: ["identity.whoami", "identity.admin"],
    scope: "session",
    description:
      "Read-only identity summary: whether a session is active and, when signed in, the principal with its linked identities. Never returns tokens.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async () => {
      const session = currentSession();
      if (!session) return { signedIn: false };
      const principal = await fetchPrincipal();
      return {
        signedIn: true,
        principal: {
          id: principal.id,
          state: principal.state,
          assurance: principal.assurance,
          createdAt: principal.createdAt,
          identities: principal.identities.map((identity) => ({
            kind: identity.kind,
            issuer: identity.issuer,
            displayHint: identity.displayHint ?? null,
            assurance: identity.assurance,
          })),
        },
      };
    },
  },
  {
    name: "opensesame_settings_read",
    capabilityIds: [
      "configs.browse",
      "sync_targets.read",
      "changelog.read",
      "backup.status",
    ],
    scope: "session",
    description:
      "Read-only settings summary: configured endpoint URLs, the active project and capability-connector bindings. Values that could carry credentials are omitted.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: () => {
      const settings = loadSettings();
      return {
        hostApi: settings.hostApi,
        identityApi: settings.identityApi,
        daemonApi: settings.daemonApi,
        mfaAppUrl: settings.mfaAppUrl,
        activeProjectId: settings.activeProjectId ?? null,
        capabilityConnectors: settings.capabilityConnectors,
      };
    },
  },
  {
    name: "opensesame_open_relay_approval",
    capabilityIds: ["relay.decide"],
    scope: "session",
    description:
      "Open the relay approval inbox on a pending request so the human can approve or deny it. Never decides; the consent click stays with the person.",
    inputSchema: {
      type: "object",
      properties: { requestId: { type: "string" } },
      required: ["requestId"],
      additionalProperties: false,
    },
    execute: (args) =>
      ceremonyOpened(
        `/access?view=requests&request=${encodeURIComponent(str(args, "requestId"))}`,
      ),
  },
  {
    name: "opensesame_open_delegation_claim",
    capabilityIds: ["delegations.claim"],
    scope: "session",
    description:
      "Open the delegation claim ceremony, prefilled with a claim token and user code when given. The human reviews and accepts; nothing is claimed by this tool.",
    inputSchema: {
      type: "object",
      properties: {
        claimToken: { type: "string" },
        userCode: { type: "string" },
      },
      additionalProperties: false,
    },
    execute: (args) => {
      const query = new URLSearchParams({ view: "claim" });
      const token = optStr(args, "claimToken");
      const code = optStr(args, "userCode");
      if (token) query.set("token", token);
      if (code) query.set("code", code);
      return ceremonyOpened(`/access?${query.toString()}`);
    },
  },
  {
    name: "opensesame_open_connect_ceremony",
    capabilityIds: ["connections.create", "connections.bindings"],
    scope: "session",
    description:
      "Open the connect ceremony for a provider (and optionally an existing connection) so the human can grant consent or enter a credential. Never completes the ceremony.",
    inputSchema: {
      type: "object",
      properties: {
        providerId: { type: "string" },
        connectionId: { type: "string" },
      },
      additionalProperties: false,
    },
    execute: (args) => {
      const provider = optStr(args, "providerId");
      const connection = optStr(args, "connectionId");
      let location = "/connections";
      if (provider) {
        location += `/${encodeURIComponent(provider)}`;
        if (connection) location += `/${encodeURIComponent(connection)}`;
      }
      return ceremonyOpened(location);
    },
  },
  {
    name: "opensesame_open_reveal",
    capabilityIds: ["vault.items.reveal"],
    scope: "session",
    description:
      "Open a vault item's detail view so the human can reveal or copy its secret. The secret is never returned here.",
    inputSchema: {
      type: "object",
      properties: { itemId: { type: "string" } },
      required: ["itemId"],
      additionalProperties: false,
    },
    execute: (args) => {
      requireUnlocked();
      const item = findItem(str(args, "itemId"));
      return ceremonyOpened(`/vault/${encodeURIComponent(item.id)}`);
    },
  },
];
