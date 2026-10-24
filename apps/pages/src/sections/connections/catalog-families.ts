/** One browse tile per provider family, with its API surfaces listed inside. */
import { canonicalProviderId } from "@opensesame/app-core/lib/connector-catalog.js";

export type ApiFamily = {
  readonly id: string;
  readonly name: string;
  readonly members: readonly string[];
};

export const API_FAMILIES: readonly ApiFamily[] = [
  {
    id: "microsoft",
    name: "Microsoft",
    members: ["microsoft", "m365", "microsoft-teams"],
  },
  {
    id: "vercel",
    name: "Vercel",
    members: ["vercel", "vercel-ai-gateway"],
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    members: [
      "cloudflare",
      "cloudflare-origin-ca",
      "cloudflare-ai-gateway",
      "cloudflare-workers-ai",
    ],
  },
  {
    id: "google",
    name: "Google",
    members: [
      "google",
      "google-drive",
      "gemini",
      "google-vertex",
      "google-wallet",
    ],
  },
  {
    id: "azure-kms",
    name: "Azure",
    members: [
      "azure-kms",
      "azure-sm",
      "azure-ac",
      "azure-openai",
      "azure-access-token",
    ],
  },
  {
    id: "aws",
    name: "AWS",
    members: [
      "aws",
      "aws-kms",
      "aws-ps",
      "aws-sts",
      "aws-bedrock",
      "amazon-nova",
    ],
  },
  {
    id: "gcp",
    name: "GCP",
    members: ["gcp", "gcp-kms", "gcp-iam"],
  },
] as const;

const BY_MEMBER = new Map(
  API_FAMILIES.flatMap((family) =>
    family.members.map((member) => [member, family] as const),
  ),
);

/**
 * The catalog id a row stands for. A family names its members by catalog id,
 * and this build keeps some rows under one of the catalog's aliases
 * (`aws-secrets-manager` is `aws`, spec/connectors/catalog.json).
 */
function catalogId(providerId: string): string {
  return canonicalProviderId(providerId) ?? providerId;
}

export function apiFamilyFor(providerId: string): ApiFamily | undefined {
  return BY_MEMBER.get(providerId) ?? BY_MEMBER.get(catalogId(providerId));
}

/** The row this build has for a member, which may carry an alias of its id. */
function memberRow<Row extends { readonly id: string }>(
  member: string,
  providers: readonly Row[],
): Row | undefined {
  return (
    providers.find((candidate) => candidate.id === member) ??
    providers.find((candidate) => catalogId(candidate.id) === member)
  );
}

/**
 * The family's APIs as its provider page offers them: each member by the row
 * this build has for it, which may carry an alias of the member's catalog id.
 * A member with no row is not offered; its page would be "Connector not found".
 */
export function familyOptionsFor(
  family: ApiFamily,
  providers: readonly { readonly id: string; readonly displayName: string }[],
): { id: string; label: string }[] {
  return family.members.flatMap((member) => {
    const row = memberRow(member, providers);
    return row ? [{ id: row.id, label: row.displayName }] : [];
  });
}

/**
 * The row a family's tile opens: the family's own row where this build carries
 * it, else the first member it does. A browser cannot hold Azure Key Vault
 * Keys (ADR 0152), so the Azure tile opens Key Vault Secrets, whose page
 * offers the rest of the family.
 */
export function familyTileRow<Row extends { readonly id: string }>(
  family: ApiFamily,
  providers: readonly Row[],
): Row | undefined {
  for (const member of family.members) {
    const row = memberRow(member, providers);
    if (row) return row;
  }
  return undefined;
}

/**
 * The id a catalog tile goes by: its family's catalog id for the row a family
 * tile opens, else the row's own id. Either names a catalog row.
 */
export function catalogTileId(providerId: string): string {
  return apiFamilyFor(providerId)?.id ?? providerId;
}
