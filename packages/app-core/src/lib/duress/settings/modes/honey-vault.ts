/**
 * HoneyVault: a decoy that reads as a working vault seeded with synthetic
 * proxy credentials. Each planted credential is a honey token; its use through
 * the surrogate proxy is a critical notice in the owner's store.
 */
import { type JsonValue, isJsonObject, isString } from "@opensesame/os-domain";
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

const DECOY_TOKEN =
  /^(?:osr_hny_[0-9a-f]{32}_[0-9a-f]{32}|osr_c0de[0-9a-f]{28})$/u;

function honeyVaultRecord(raw: JsonValue): HoneyVaultItem[] {
  if (!isJsonObject(raw)) return [];
  const { title, token } = raw;
  if (!isString(title) || title.length === 0 || title.length > 128) return [];
  if (!isString(token) || !DECOY_TOKEN.test(token)) return [];
  return [{ title, token }];
}

export function honeyVaultRecords(body: JsonValue): readonly HoneyVaultItem[] {
  if (!isJsonObject(body)) return [];
  if (body.v !== 1 || !Array.isArray(body.items)) return [];
  return body.items.flatMap(honeyVaultRecord);
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
