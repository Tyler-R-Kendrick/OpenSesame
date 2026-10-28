import { canonicalProviderId } from "@opensesame/app-core/lib/connector-catalog.js";

/** One browse tile per provider family, with its API surfaces listed inside. */

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
    id: "azure-sm",
    name: "Azure",
    members: [
      "azure-sm",
      "azure-kms",
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

export function apiFamilyFor(providerId: string): ApiFamily | undefined {
  return BY_MEMBER.get(canonicalProviderId(providerId) ?? providerId);
}

/** Hide non-canonical members from the browse list; their family tile owns them. */
export function isFamilyCanonical(providerId: string): boolean {
  return API_FAMILIES.some((family) => family.id === providerId);
}
