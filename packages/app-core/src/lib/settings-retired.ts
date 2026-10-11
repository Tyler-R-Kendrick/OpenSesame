/**
 * Where a link to a retired Settings address lands now (ADR 0188).
 *
 * Settings › Capabilities split into Features and Integrations, and the
 * Connections, Backups and Cloud secrets categories before it. Anyone can hold
 * an old link — a bookmark, a shared address, a tutorial written before — so
 * the category alone (`crumbs.ts`' alias table) is not enough: the fragment
 * names a section, which may have gone to the other page, and `?file=` names a
 * capability document that moved with its directory.
 *
 * Pure: the address in, the address out, or `null` when it is current.
 */

import {
  BUILT_IN_INTEGRATIONS,
  INTEGRATIONS,
  type IntegrationId,
} from "./capabilities/integrations.js";
import { retiredSettingsCategory } from "./settings-aliases.js";

/** A retired category whose name is itself a section of Integrations. */
const NAMED_SECTION = new Map<string, IntegrationId>([
  ["backups", "backups"],
  ["cloud-secrets", "cloud-secret-storage"],
]);

/** Provider tiles are an `<ul id="<category>">`; old links used the bare category. */
const CATEGORY_FRAGMENTS: ReadonlySet<string> = new Set(
  INTEGRATIONS.flatMap((entry) => entry.providerCategories),
);

const CAPABILITY_DIRECTORY = "settings/capabilities/";
const FEATURES_DIRECTORY = "settings/features/";

type Landing = Readonly<{
  category: "features" | "integrations";
  fragment: string;
}>;

/**
 * The page and fragment of an old `/settings/capabilities` link.
 * `#feature-<id>` stays on Features unless that section is built in, and a
 * bare connector family (`#backup_recovery`) is an Integrations tile list.
 */
function capabilitiesLanding(fragment: string): Landing {
  const topic = fragment.startsWith("feature-") ? fragment.slice(8) : null;
  if (topic !== null && BUILT_IN_INTEGRATIONS.has(topic)) {
    return { category: "integrations", fragment: `integration-${topic}` };
  }
  if (CATEGORY_FRAGMENTS.has(fragment)) {
    return { category: "integrations", fragment };
  }
  return { category: "features", fragment };
}

/** A capability document opened by path keeps its name in the new directory. */
function movedFile(search: string): string {
  const params = new URLSearchParams(search);
  const file = params.get("file");
  if (file === null || !file.startsWith(CAPABILITY_DIRECTORY)) return search;
  params.set(
    "file",
    FEATURES_DIRECTORY + file.slice(CAPABILITY_DIRECTORY.length),
  );
  return `?${params.toString()}`;
}

function address(category: string, search: string, fragment: string): string {
  return `/settings/${category}${search}${fragment ? `#${fragment}` : ""}`;
}

/**
 * The current address for `pathname`, `search` and `hash`, or `null` when they
 * already are one. A connector's own page (`/settings/connections/<provider>`)
 * is a current route and is left alone, and so is a retired name that now
 * reads as a category this split did not touch (`#unlock`).
 */
export function retiredSettingsAddress(
  pathname: string,
  search: string,
  hash: string,
): string | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "settings" || parts.length > 2) return null;
  const fragment = hash.replace(/^#/, "");
  // `/settings#backups`: with no category in the path the fragment names it.
  const named = parts[1] ?? fragment;
  const target = retiredSettingsCategory(named);
  if (target !== "features" && target !== "integrations") return null;
  const kept = parts[1] === undefined ? "" : fragment;
  if (named === "capabilities") {
    const landing = capabilitiesLanding(kept);
    return address(landing.category, movedFile(search), landing.fragment);
  }
  const section = NAMED_SECTION.get(named);
  return address(
    target,
    search,
    section === undefined ? kept : `integration-${section}`,
  );
}
