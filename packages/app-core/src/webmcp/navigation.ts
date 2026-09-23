import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { itemTypeRegistry } from "@opensesame/vault-core";
import type { WebMcpToolSpec } from "@opensesame/webmcp";
import { COMMAND_SECTIONS, commandSections } from "../lib/command-bar/types.js";
import { settingsCategories, settingsPath } from "../lib/crumbs.js";
import { readDraftPrefill } from "../lib/vault/new-draft.js";
import { vaultStore } from "../lib/vault/store.js";

/**
 * The core sections a browser agent may name. Optional sections and their
 * tabs arrive as `command-path` contributions — the same set the command bar
 * accepts — so the two surfaces can never disagree about what exists.
 */
export const SECTION_PATHS = COMMAND_SECTIONS;

export const webmcpNavigationSeam = {
  navigate: (_to: string): void => {
    throw new Error("router_unavailable");
  },
};

/** Authored destinations only: no external URLs, arbitrary query data or selectors. */
export function navigationPaths(): string[] {
  return [
    ...new Set([
      ...commandSections(),
      ...settingsCategories().map((category) => settingsPath(category)),
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

/**
 * Share reach comes before the existence check, so an actor without a share
 * hears `share_grant_denied` for every id, real or not, and navigation is no
 * oracle for which items exist. Opening the edit ceremony needs write reach.
 */
async function itemDestination(
  section: string,
  args: JsonObject,
): Promise<string> {
  const itemId = args.itemId;
  if (
    section !== "/vault" ||
    vaultStore.getSnapshot().status !== "unlocked" ||
    !isString(itemId)
  )
    throw new Error("invalid_item_destination");
  const edit = args.edit === true;
  const { assertShareReach } = await import("../lib/local-share-reach.js");
  await assertShareReach(
    vaultStore.activeTomb(),
    { kind: "item", id: itemId },
    edit ? "write" : "read",
  );
  const { items } = vaultStore.getSnapshot();
  if (!items.some((item) => item.id === itemId && !item.deletedAt))
    throw new Error("invalid_item_destination");
  return `/${encodeURIComponent(itemId)}${edit ? "/edit" : ""}`;
}

function navigationInputSchema(): WebMcpToolSpec["inputSchema"] {
  return {
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
  };
}

export const navigationTool: WebMcpToolSpec = {
  name: "opensesame_navigate",
  description:
    "Navigate any registered section or tab, Settings category, favorites, trash, or a new-item ceremony. Use section with an authored path; for a typed new item use /vault/new and itemType. Credential entry and approvals stay with the human.",
  // Read on access, so a registration after a plan change advertises the
  // destinations that exist then; a spread copies the value at that moment.
  get inputSchema() {
    return navigationInputSchema();
  },
  async execute(args) {
    if (!isString(args.section)) throw new Error("missing_argument:section");
    const section = args.section.startsWith("/")
      ? args.section
      : `/${args.section}`;
    if (!navigationPaths().includes(section))
      throw new Error("unknown_section");
    let location = section;
    if (args.itemId !== undefined) {
      location += await itemDestination(section, args);
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
