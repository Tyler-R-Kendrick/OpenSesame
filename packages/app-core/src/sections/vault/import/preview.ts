/**
 * The import preview's view-model: which formats a person may name, where
 * the items will land, what the merge will write, and the facts and rows the
 * sheet draws. Pure — the plan is recomputed from these on every choice, so
 * the commit key can state the real number before anything is sealed.
 */
import type { Folder, VaultItem } from "@opensesame/vault-core";
import {
  ADAPTERS,
  type ImportSummary,
  type ParseResult,
  type SourceId,
  adapterFor,
  summarise,
} from "../../../lib/vault/import/index.js";
import {
  type MergeOptions,
  type MergePlan,
  planMerge,
} from "../../../lib/vault/import/merge.js";

/** Rows drawn in the preview before it collapses to a count. */
export const PREVIEW_LIMIT = 60;

/** What the file picker offers. */
export const IMPORT_ACCEPT =
  ".env,.csv,.json,.1pux,.zip,.kdbx,text/plain,text/csv,application/json";

function productOf(label: string): string {
  return label.split(" (")[0] ?? label;
}

/**
 * `ADAPTERS` is ordered by detection priority, which is meaningless to
 * someone hunting for their own product: listed by product name, with the
 * registry's order kept within a product so the richer format comes first.
 */
export const LISTED_ADAPTERS: readonly Readonly<{
  id: SourceId;
  label: string;
}>[] = ADAPTERS.map((adapter, index) => ({ adapter, index }))
  .sort(
    (a, b) =>
      productOf(a.adapter.label).localeCompare(productOf(b.adapter.label)) ||
      a.index - b.index,
  )
  .map(({ adapter }) => ({ id: adapter.id, label: adapter.label }));

export function formatLabel(source: SourceId): string {
  return adapterFor(source)?.label ?? source;
}

export function defaultFolderName(source: SourceId): string {
  return `Imported from ${adapterFor(source)?.shortName ?? "another manager"}`;
}

export type FolderMode = "keep" | "single" | "none";

/** Where the person said the items should land, and whether to skip copies. */
export type LandingChoice = Readonly<{
  mode: FolderMode;
  folderName: string;
  skipDuplicates: boolean;
}>;

/**
 * An export with folders keeps them; one without (every browser) is better
 * gathered under one name the person can find again.
 */
export function landingDefaults(result: ParseResult): LandingChoice {
  return {
    mode: result.items.some((item) => item.folder) ? "keep" : "single",
    folderName: defaultFolderName(result.source),
    skipDuplicates: true,
  };
}

export function mergeOptionsFor(
  choice: LandingChoice,
  source: SourceId,
): MergeOptions {
  return {
    intoFolder:
      choice.mode === "single"
        ? choice.folderName.trim() || defaultFolderName(source)
        : null,
    keepFolders: choice.mode === "keep",
    skipDuplicates: choice.skipDuplicates,
  };
}

export function planImport(
  result: ParseResult,
  items: VaultItem[],
  folders: Folder[],
  choice: LandingChoice,
): MergePlan {
  return planMerge(
    result.items,
    items,
    folders,
    mergeOptionsFor(choice, result.source),
  );
}

export type Fact = Readonly<{ key: string; value: string }>;

/** The summary's counts, each stated once when it is not zero. */
type Counted = Exclude<keyof ImportSummary, "folders">;

const COUNTED: readonly (readonly [Counted, string])[] = [
  ["logins", "Logins"],
  ["passkeys", "Passkeys"],
  ["cards", "Cards"],
  ["notes", "Notes"],
  ["secrets", "Secrets"],
  ["withTotp", "With a 2FA code"],
  ["withoutPassword", "Logins without a password"],
];

/** What the file holds, stated once as facts beside its format. */
export function previewFacts(result: ParseResult, plan: MergePlan): Fact[] {
  const summary = summarise(result.items);
  const facts: Fact[] = [{ key: "Format", value: formatLabel(result.source) }];
  for (const [field, key] of COUNTED) {
    const count = summary[field];
    if (count > 0) {
      facts.push({ key, value: String(count) });
    }
  }
  if (summary.folders.length > 0) {
    facts.push({ key: "Folders", value: String(summary.folders.length) });
  }
  if (plan.duplicates.length > 0) {
    facts.push({
      key: "Already here",
      value: `${plan.duplicates.length} by name and username`,
    });
  }
  if (result.skipped.length > 0) {
    facts.push({ key: "Left out", value: String(result.skipped.length) });
  }
  // What the format cannot carry is read, not hovered: a fact, said once.
  for (const warning of result.warnings) {
    facts.push({ key: "Note", value: warning });
  }
  return facts;
}

/** The folders the export names, for the "recreate" choice. */
export function exportFolders(result: ParseResult): string[] {
  return summarise(result.items).folders;
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The commit key's words: the real number the merge will write. */
export function commitLabel(plan: MergePlan): string {
  return plan.items.length === 0
    ? "Nothing to import"
    : `Import ${plural(plan.items.length, "item", "items")}`;
}

export type PreviewRow = Readonly<{
  id: string;
  name: string;
  detail: string;
  folder: string;
}>;

/** Rows drawn, and how many more the file holds. */
export type PreviewRows = Readonly<{ rows: PreviewRow[]; hidden: number }>;

/** The first `PREVIEW_LIMIT` items as rows, and how many more there are. */
export function previewRows(plan: MergePlan, folders: Folder[]): PreviewRows {
  const names = new Map<string, string>();
  for (const folder of [...folders, ...plan.newFolders]) {
    names.set(folder.id, folder.name);
  }
  const rows = plan.items.slice(0, PREVIEW_LIMIT).map((item) => ({
    id: item.id,
    name: item.name,
    detail:
      item.kind === "account"
        ? item.username || "—"
        : item.kind === "secret"
          ? "secret"
          : "—",
    folder: item.folderId ? (names.get(item.folderId) ?? "—") : "—",
  }));
  return { rows, hidden: plan.items.length - rows.length };
}

/** What landed, as the done card's facts. */
export function doneFacts(done: {
  added: number;
  skipped: number;
  restored: boolean;
  updated?: number;
}): Fact[] {
  const facts: Fact[] = [{ key: "Added", value: String(done.added) }];
  if ((done.updated ?? 0) > 0) {
    facts.push({ key: "Updated", value: String(done.updated) });
  }
  if (done.skipped > 0) {
    facts.push({ key: "Already here", value: String(done.skipped) });
  }
  facts.push({ key: "Sealed under", value: "this vault's key" });
  if (!done.restored) {
    facts.push({ key: "Export file", value: "plain text — delete it" });
  }
  return facts;
}
