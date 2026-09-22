/**
 * Vault item tools — search, metadata read/write, TOTP code, and the reveal
 * ceremony opener. These belong to the core `vault.passwords` capability:
 * the core registers them as `webmcp-tool` contributions and `agents.webmcp`
 * exposes whichever of them the plan approves. Secret material never leaves
 * through any of them (`projectVaultItemMeta` is the allowlist).
 */

import { isBoolean } from "@opensesame/os-domain";
import { buildHealthReport } from "../lib/vault/health.js";
import {
  type DropState,
  type ItemKind,
  type LegacyItemKind,
  type PasskeyCustody,
  type UriMatch,
  type VaultItem,
  activeItems,
  newUri,
  searchMatches,
} from "../lib/vault/model.js";
import { newItemDraft } from "../lib/vault/new-draft.js";
import { vaultStore } from "../lib/vault/store.js";
import { parseTotp, secondsRemaining, totpCode } from "../lib/vault/totp.js";
import {
  assertMetadataOnlyWrite,
  suggestItemMetadata,
} from "./draft-suggestions.js";
import {
  type PagesWebMcpTool,
  ceremonyOpened,
  findItem,
  optStr,
  requireUnlocked,
  str,
} from "./tool-shared.js";

const ITEM_KINDS: readonly LegacyItemKind[] = [
  "login",
  "passkey",
  "card",
  "secret",
  "note",
  "certificate",
  "drop",
];

/** WebMCP writes only kinds that predate the item-type registry (ADR 0087). */
function isItemKind(value: string): value is LegacyItemKind {
  return ITEM_KINDS.some((kind) => kind === value);
}

async function assertItemReach(
  itemId: string,
  wanted: "read" | "write",
): Promise<void> {
  const { assertShareReach } = await import("../lib/local-share-reach.js");
  await assertShareReach(
    vaultStore.activeTomb(),
    { kind: "item", id: itemId },
    wanted,
  );
}

async function assertVaultWrite(): Promise<void> {
  const { assertShareReach } = await import("../lib/local-share-reach.js");
  await assertShareReach(vaultStore.activeTomb(), { kind: "vault" }, "write");
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
  typeId?: string;
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
    // A plugin-defined item names its type and nothing else. The allowlist is
    // the point: a definition author must not be able to widen what leaves the
    // vault into agent context by declaring a field (ADR 0087 §5).
    case "typed":
      return { ...base, typeId: item.typeId };
  }
}

function healthIssuesById(): Map<string, string[]> {
  const report = buildHealthReport(vaultStore.getSnapshot().items);
  return new Map(
    report.findings.map((finding) => [finding.item.id, [...finding.issues]]),
  );
}

export const TOTP_RATE_LIMIT_MS = 2000;
const totpLastIssuedAt = new Map<string, number>();

export function resetTotpRateLimitForTests(): void {
  totpLastIssuedAt.clear();
}

export const VAULT_TOOLS: readonly PagesWebMcpTool[] = [
  {
    name: "opensesame_vault_search",
    capabilityIds: ["vault.items.search"],
    scope: "session",
    readOnly: true,
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
    execute: async (args) => {
      requireUnlocked();
      const query = optStr(args, "query");
      const kind = optStr(args, "kind");
      const folderId = optStr(args, "folderId");
      const favorites = args.favorites === true;
      if (kind && !isItemKind(kind)) {
        throw new Error(`unknown_kind:${kind}`);
      }
      const issues = healthIssuesById();
      const candidates = activeItems(vaultStore.getSnapshot().items)
        .filter((item) => (kind ? item.kind === kind : true))
        .filter((item) => (folderId ? item.folderId === folderId : true))
        .filter((item) => (favorites ? item.favorite : true))
        .filter((item) => (query ? searchMatches(item, query) : true));
      const items = [];
      for (const item of candidates) {
        try {
          await assertItemReach(item.id, "read");
        } catch {
          continue;
        }
        items.push({
          ...projectVaultItemMeta(item),
          healthIssues: issues.get(item.id) ?? [],
        });
      }
      return { items, folders: vaultStore.getSnapshot().folders };
    },
  },
  {
    name: "opensesame_vault_item_read",
    capabilityIds: ["vault.items.read_meta"],
    scope: "session",
    readOnly: true,
    description:
      "Read one vault item's metadata by id: name, kind, folder, flags, timestamps and health issues. Secret fields are never included; use opensesame_open_reveal to hand a reveal to the human.",
    inputSchema: {
      type: "object",
      properties: { itemId: { type: "string" } },
      required: ["itemId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      requireUnlocked();
      const item = findItem(str(args, "itemId"));
      await assertItemReach(item.id, "read");
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
      "Create a vault item with local generated defaults, or edit non-secret metadata. With action=suggest, return only a name and fictional username (source=random or browser for the ready on-device model); nothing is saved. Secret input/output is forbidden.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["suggest"] },
        source: {
          type: "string",
          enum: ["random", "browser"],
          description:
            "Only with action=suggest. No remote model fallback or downloads.",
        },
        itemId: {
          type: "string",
          description: "Existing item to edit; omit to create.",
        },
        kind: {
          type: "string",
          description:
            "Installed item type ID; required when creating or suggesting.",
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
      if (args.action === "suggest") return suggestItemMetadata(args);
      assertMetadataOnlyWrite(args);
      const itemId = optStr(args, "itemId");
      if (itemId) await assertItemReach(itemId, "write");
      else await assertVaultWrite();
      const name = optStr(args, "name");
      const folderId = optStr(args, "folderId");
      const url = optStr(args, "url");
      const favorite = isBoolean(args.favorite) ? args.favorite : null;

      let item: VaultItem;
      if (itemId) {
        item = { ...findItem(itemId) };
      } else {
        const kind = str(args, "kind");
        item = newItemDraft(kind, name ?? undefined);
      }
      if (name) item.name = name;
      if (folderId !== null) item.folderId = folderId;
      if (favorite !== null) item.favorite = favorite;
      if (url !== null) {
        if (item.kind !== "login") {
          throw new Error("url_requires_login_item");
        }
        const [first = newUri(), ...rest] = item.uris;
        item.uris = [{ ...first, uri: url, match: "domain" }, ...rest];
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
];

/** Opens the item so the human can reveal; listed after the ceremonies. */
export const OPEN_REVEAL_TOOL: PagesWebMcpTool = {
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
};
