/**
 * HoneyVault: a decoy that reads as a working vault seeded with synthetic
 * proxy credentials. Each planted credential is a honey token; its use through
 * the surrogate proxy is a critical notice in the owner's store.
 */
import type { JsonValue } from "@opensesame/os-domain";
import { mintHoneyToken } from "../../../honey-tokens.js";
import type { DuressMode, DuressPlan } from "./mode.js";

export const HONEY_VAULT_ITEMS = [
  "AWS production",
  "Stripe live",
  "GitHub CI",
  "Cloudflare deploy",
  "Postgres read replica",
  "Internal admin API",
] as const;

const MAX_ITEMS = HONEY_VAULT_ITEMS.length;

export type HoneyVaultItem = Readonly<{ title: string; token: string }>;
export type HoneyVaultBody = Readonly<{
  v: 1;
  items: readonly HoneyVaultItem[];
}>;

export function honeyVaultRecords(body: JsonValue): readonly HoneyVaultItem[] {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return [];
  const value = body as Record<string, unknown>;
  if (value.v !== 1 || !Array.isArray(value.items)) return [];
  return value.items.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];
    const row = raw as Record<string, unknown>;
    if (
      typeof row.title !== "string" ||
      row.title.length === 0 ||
      row.title.length > 128 ||
      typeof row.token !== "string" ||
      !/^osr_hny_[0-9a-f]{32}_[0-9a-f]{32}$/u.test(row.token)
    )
      return [];
    return [{ title: row.title, token: row.token }];
  });
}

function planFor(): DuressPlan {
  const items = HONEY_VAULT_ITEMS.slice(0, MAX_ITEMS).map((title) => ({
    title,
    token: mintHoneyToken().token,
  }));
  return { effect: "honey_vault", body: { v: 1, items } };
}

export const HONEY_VAULT = {
  id: "honey_vault",
  label: "HoneyVault",
  opens: "a decoy vault holding synthetic credentials that alert on use",
  consent:
    "I understand this code opens a decoy seeded with synthetic honey-token credentials; any use of one alerts me and never reaches my vault.",
  presentation: "decoy",
  input: { kind: "none" },
  plan: planFor,
} as const satisfies DuressMode;
