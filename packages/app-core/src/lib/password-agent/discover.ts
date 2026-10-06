import { passwordAgentPolicy as policy } from "./policy.js";
import {
  type DiscoveryField,
  type DiscoveryItem,
  type JsonValue,
  discoveryItemSchema,
} from "./provider-schema.js";
import {
  type PasswordAgentPort,
  type Scope,
  documents,
  invoke,
  json,
  record,
  records,
  string,
} from "./transport.js";
export interface InventoryItem {
  id: string;
  title: string;
  vault: string;
  kind: string;
  tags: string[];
  urls: string[];
  urlsNeedReview?: boolean;
  createdAt?: string;
  updatedAt?: string;
  fields: {
    label: string;
    type: string;
    purpose?: string;
    section?: string;
    ref?: string;
  }[];
}
export interface SecretMatch {
  ref: string;
  title: string;
  kind: string;
  queries?: string[];
}
export interface FindResult {
  matches: SecretMatch[];
  suggestions?: (SecretMatch & { query: string })[];
}
const kind = (value: string) => value.toLowerCase().replaceAll("_", "-");
/** Saved URLs may contain credentials in any component, including the path. */
export function metadataOrigin(input: string): string {
  try {
    const url = new URL(input);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin
      : "";
  } catch {
    return "";
  }
}
export function hasTransientUrl(input: string): boolean {
  return policy.transientUrlTerms.some((term) =>
    input.toLowerCase().includes(term),
  );
}
function inventoryField(
  field: DiscoveryField,
): InventoryItem["fields"][number] {
  const result: InventoryItem["fields"][number] = {
    label: field.label ?? field.id,
    type: field.type.toLowerCase(),
  };
  if (field.purpose !== undefined) result.purpose = field.purpose.toLowerCase();
  if (field.section?.label !== undefined) result.section = field.section.label;
  if (field.reference?.startsWith("op://")) result.ref = field.reference;
  return result;
}
function inventoryItem(item: DiscoveryItem): InventoryItem {
  const result: InventoryItem = {
    id: item.id,
    title: item.title,
    vault: item.vault.name,
    kind: kind(item.category),
    tags: [...(item.tags ?? [])].sort(),
    urls: [
      ...new Set(
        (item.urls ?? [])
          .map(({ href }) => metadataOrigin(href))
          .filter(Boolean),
      ),
    ],
    fields: item.fields.map(inventoryField),
  };
  if ((item.urls ?? []).some(({ href }) => hasTransientUrl(href)))
    result.urlsNeedReview = true;
  if (item.created_at !== undefined) result.createdAt = item.created_at;
  if (item.updated_at !== undefined) result.updatedAt = item.updated_at;
  return result;
}
export function inventoryFromItems(
  input: readonly JsonValue[],
): InventoryItem[] {
  return input
    .map((raw) => inventoryItem(discoveryItemSchema.parse(raw)))
    .sort(
      (a, b) =>
        a.vault.localeCompare(b.vault) || a.title.localeCompare(b.title),
    );
}
const words = (value: string) =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = row;
  }
  return previous[b.length] ?? 0;
}
function score(query: string, title: string): number {
  const terms = words(query);
  const candidates = words(title);
  return terms.length
    ? terms.reduce(
        (sum, term) =>
          sum +
          Math.max(
            0,
            ...candidates.map((word) =>
              word.includes(term) || (word.length >= 3 && term.includes(word))
                ? 1
                : 1 - distance(term, word) / Math.max(term.length, word.length),
            ),
          ),
        0,
      ) / terms.length
    : 0;
}
function searches(queries: readonly string[], items: readonly InventoryItem[]) {
  return [...new Set(queries)].map((query) => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matched = items.filter((item) =>
      terms.every((term) => item.title.toLowerCase().includes(term)),
    );
    const suggested = matched.length
      ? []
      : items
          .map((item) => ({ item, score: score(query, item.title) }))
          .filter((entry) => entry.score >= policy.suggestionThreshold)
          .sort(
            (a, b) =>
              b.score - a.score || a.item.title.localeCompare(b.item.title),
          )
          .slice(0, policy.suggestionLimit)
          .map(({ item }) => item);
    return { query, matched, suggested };
  });
}
export function findInItems(
  queries: readonly string[],
  items: readonly InventoryItem[],
) {
  const results = searches(queries, items);
  const matches = new Map<string, SecretMatch>();
  const suggestions: (SecretMatch & { query: string })[] = [];
  const secrets = (item: InventoryItem) =>
    item.fields.flatMap((field) =>
      field.ref && (field.type === "concealed" || field.purpose === "password")
        ? [{ ref: field.ref, title: item.title, kind: item.kind }]
        : [],
    );
  for (const { query, matched, suggested } of results) {
    for (const item of matched)
      for (const secret of secrets(item)) {
        addMatch(matches, secret, query, results.length);
      }
    for (const item of suggested)
      for (const secret of secrets(item))
        suggestions.push({ ...secret, query });
  }
  const result: FindResult = {
    matches: [...matches.values()].sort((a, b) => a.ref.localeCompare(b.ref)),
  };
  if (suggestions.length) result.suggestions = suggestions;
  return result;
}
async function list(port: PasswordAgentPort, scope: Scope) {
  return records(
    await json(
      port,
      [
        "item",
        "list",
        "--format",
        "json",
        ...(scope.vault ? ["--vault", scope.vault] : []),
      ],
      scope,
    ),
  );
}
async function details(
  port: PasswordAgentPort,
  items: readonly JsonValue[],
  scope: Scope,
) {
  if (!items.length) return [];
  const raw = await invoke(port, ["item", "get", "-", "--format", "json"], {
    ...scope,
    input: `${JSON.stringify(items)}\n`,
  });
  try {
    return inventoryFromItems(documents(raw));
  } catch {
    throw new Error(
      "1Password returned invalid item metadata (details suppressed)",
    );
  }
}
export async function inventory(port: PasswordAgentPort, scope: Scope = {}) {
  return details(port, await list(port, scope), scope);
}
export async function find(
  port: PasswordAgentPort,
  queries: readonly string[],
  scope: Scope = {},
) {
  const listed = await list(port, scope);
  const summaries = listed.map((item) => ({
    id: string(item.id),
    title: string(item.title),
    vault: string(record(item.vault).name),
    kind: kind(string(item.category)),
    tags: [],
    urls: [],
    fields: [],
  }));
  const wanted = new Set(
    searches(queries, summaries).flatMap(({ matched, suggested }) =>
      [...matched, ...suggested].map((item) => item.id),
    ),
  );
  return findInItems(
    queries,
    await details(
      port,
      listed.filter((item) => wanted.has(string(item.id))),
      scope,
    ),
  );
}
export function auditInventory(
  items: readonly InventoryItem[],
  now = new Date(),
) {
  const cutoff = new Date(now);
  cutoff.setFullYear(cutoff.getFullYear() - policy.oldLoginYears);
  const groups = new Map<string, InventoryItem[]>();
  for (const item of items) {
    const key = item.title.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const machine = new Set(policy.machineKinds);
  return {
    summary: {
      items: items.length,
      tagged: items.filter((item) => item.tags.length).length,
      untagged: items.filter((item) => !item.tags.length).length,
    },
    duplicateTitles: [...groups.values()]
      .filter((group) => group.length > 1)
      .map((group) => ({
        title: group[0]?.title ?? "",
        items: group.map(({ id, title }) => ({ id, title })),
      })),
    untaggedMachineCredentials: items
      .filter((item) => !item.tags.length && machineCredential(item, machine))
      .map(({ id, title, kind }) => ({ id, title, kind })),
    oldLogins: items
      .filter(
        (item) =>
          (item.kind === "login" ||
            (item.kind === "account" &&
              item.fields.some((field) => field.purpose === "password"))) &&
          item.updatedAt !== undefined &&
          item.updatedAt < cutoff.toISOString(),
      )
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
    urlsToReview: items.flatMap((item) => {
      const needsReview =
        item.urlsNeedReview || item.urls.some(hasTransientUrl);
      const urls = [...new Set(item.urls.map(metadataOrigin).filter(Boolean))];
      return needsReview
        ? [{ id: item.id, title: item.title, urls, reason: "transient-url" }]
        : [];
    }),
  };
}
export async function audit(
  port: PasswordAgentPort,
  scope: Scope = {},
  now?: Date,
) {
  return auditInventory(await inventory(port, scope), now);
}

function addMatch(
  matches: Map<string, SecretMatch>,
  secret: SecretMatch,
  query: string,
  searchCount: number,
) {
  const current = matches.get(secret.ref);
  if (current) {
    current.queries?.push(query);
    return;
  }
  const entry: SecretMatch = { ...secret };
  if (searchCount > 1) entry.queries = [query];
  matches.set(secret.ref, entry);
}

function machineCredential(
  item: InventoryItem,
  kinds: ReadonlySet<string>,
): boolean {
  if (kinds.has(item.kind)) return true;
  const purposes = new Set(["api-key", "token", "oauth"]);
  return (
    item.kind === "account" &&
    item.fields.some(
      (field) => field.purpose !== undefined && purposes.has(field.purpose),
    )
  );
}
