import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import type { WebMcpToolSpec } from "@opensesame/webmcp";
import { SETTINGS_CATEGORIES, settingsPath } from "../lib/crumbs.js";
import { ACCESS_VIEWS, IDENTITY_VIEWS } from "../lib/section-views.js";
import { itemTypeRegistry } from "../lib/vault/item-types.js";
import { readDraftPrefill } from "../lib/vault/new-draft.js";
import { vaultStore } from "../lib/vault/store.js";

export const SECTION_PATHS = [
  "/vault",
  "/connections",
  "/access",
  "/identity",
  "/settings",
] as const;

export const webmcpNavigationSeam = {
  navigate: (_to: string): void => {
    throw new Error("router_unavailable");
  },
};

/** Authored destinations only: no external URLs, arbitrary query data or selectors. */
export function navigationPaths(): string[] {
  return [
    ...new Set([
      ...SECTION_PATHS,
      ...SETTINGS_CATEGORIES.map((category) => settingsPath(category)),
      ...ACCESS_VIEWS.map((view) => `/access?view=${view}`),
      ...IDENTITY_VIEWS.map((view) => `/identity?view=${view}`),
      "/vault/new",
      "/vault?f=favorites",
      "/vault?f=trash",
    ]),
  ];
}

function prefillQuery(value: JsonValue | undefined, typeId: string): string {
  if (!isJsonObject(value)) throw new Error("invalid_prefill");
  const search = new URLSearchParams();
  for (const [key, entry] of Object.entries(value)) {
    if (!isString(entry)) throw new Error("invalid_prefill");
    search.set(key, entry);
  }
  readDraftPrefill(search, typeId);
  return search.size ? `?${search}` : "";
}

function itemDestination(section: string, args: JsonObject): string {
  const snapshot = vaultStore.getSnapshot();
  if (
    section !== "/vault" ||
    snapshot.status !== "unlocked" ||
    !isString(args.itemId) ||
    !snapshot.items.some((item) => item.id === args.itemId && !item.deletedAt)
  )
    throw new Error("invalid_item_destination");
  return `/${encodeURIComponent(args.itemId)}${args.edit === true ? "/edit" : ""}`;
}

export const navigationTool: WebMcpToolSpec = {
  name: "opensesame_navigate",
  description:
    "Navigate any main section, Access or Identity tab, Settings category, favorites, trash, or a new-item ceremony. Use section with an authored path; for a typed new item use /vault/new and itemType. Credential entry and approvals stay with the human.",
  inputSchema: {
    type: "object",
    properties: {
      section: { type: "string", enum: navigationPaths() },
      itemType: {
        type: "string",
        description: "Installed item type ID, only with /vault/new.",
      },
      itemId: {
        type: "string",
        description:
          "Existing item ID, only with /vault. Opens the item without returning its secrets.",
      },
      edit: {
        type: "boolean",
        description: "With itemId, open the human edit ceremony.",
      },
      prefill: {
        type: "object",
        properties: {
          name: { type: "string", maxLength: 120 },
          username: { type: "string", maxLength: 120 },
          uri: { type: "string", maxLength: 120 },
          folder: { type: "string", maxLength: 120 },
          ref: { type: "string", maxLength: 120 },
        },
        patternProperties: {
          "^field\\.[a-zA-Z][a-zA-Z0-9_-]*$": {
            type: "string",
            maxLength: 120,
          },
        },
        additionalProperties: false,
        description:
          "Public metadata only, with /vault/new. Opens a reviewable draft; never include a password, token or other sensitive value.",
      },
    },
    required: ["section"],
    additionalProperties: false,
  },
  execute(args) {
    if (!isString(args.section)) throw new Error("missing_argument:section");
    const section = args.section.startsWith("/")
      ? args.section
      : `/${args.section}`;
    if (!navigationPaths().includes(section))
      throw new Error("unknown_section");
    let location = section;
    if (args.itemId !== undefined) {
      location += itemDestination(section, args);
    } else if (args.edit !== undefined) throw new Error("edit_requires_item");
    if (args.itemType !== undefined) {
      if (
        section !== "/vault/new" ||
        !isString(args.itemType) ||
        !itemTypeRegistry().has(args.itemType)
      ) {
        throw new Error("invalid_item_type_destination");
      }
      location += `/${encodeURIComponent(args.itemType)}`;
    }
    if (args.prefill !== undefined) {
      if (section !== "/vault/new") throw new Error("invalid_prefill");
      location += prefillQuery(
        args.prefill,
        isString(args.itemType) ? args.itemType : "login",
      );
    }
    webmcpNavigationSeam.navigate(location);
    return { status: "navigated", location };
  },
};
