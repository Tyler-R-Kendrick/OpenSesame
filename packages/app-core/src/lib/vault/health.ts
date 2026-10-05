import {
  type AccountItem,
  type VaultItem,
  accountPlainPassword,
  accountTotp,
  hostOf,
  needsPepper,
  passwordMethod,
} from "@opensesame/vault-core";
import { estimateStrength } from "./password.js";

export type HealthIssue = "weak" | "reused" | "old" | "no-2fa";

export type HealthFinding = {
  item: AccountItem;
  issues: HealthIssue[];
  /** Other item names sharing this password, when reused. */
  sharedWith: string[];
  bits: number;
};

export type HealthReport = {
  findings: HealthFinding[];
  scored: number;
  clean: number;
  /**
   * Accounts whose password needs a pepper (or is a Sphinx password): health
   * cannot prompt, so it neither reads nor scores them (ADR 0172 §4).
   */
  unchecked: number;
  counts: Record<HealthIssue, number>;
};

const OLD_PASSWORD_DAYS = 365;

export const ISSUE_LABEL = {
  weak: "Weak",
  reused: "Reused",
  old: "Over a year old",
  "no-2fa": "No 2FA",
};

export const ISSUE_EXPLANATION = {
  weak: "Short or predictable enough to be guessed offline. Generate a replacement.",
  reused: "One breach elsewhere unlocks every account sharing this password.",
  old: "Rotate passwords you have held for more than a year.",
  "no-2fa": "This account has no authenticator secret stored.",
};

export function buildHealthReport(items: VaultItem[]): HealthReport {
  const live = items.filter(
    (item): item is AccountItem =>
      item.kind === "account" && item.deletedAt === null,
  );
  const accounts = live.filter(
    (account) => accountPlainPassword(account) !== "",
  );
  const unchecked = live.filter((account) => {
    const method = passwordMethod(account);
    return method !== undefined && needsPepper(method);
  }).length;

  const byPassword = new Map<string, AccountItem[]>();
  for (const account of accounts) {
    const password = accountPlainPassword(account);
    const bucket = byPassword.get(password);
    if (bucket) bucket.push(account);
    else byPassword.set(password, [account]);
  }

  const cutoff = Date.now() - OLD_PASSWORD_DAYS * 86_400_000;
  const counts = {
    weak: 0,
    reused: 0,
    old: 0,
    "no-2fa": 0,
  };
  const findings: HealthFinding[] = [];

  for (const account of accounts) {
    const password = accountPlainPassword(account);
    const issues: HealthIssue[] = [];
    const strength = estimateStrength(password);
    if (strength.score <= 1) issues.push("weak");

    const shared = (byPassword.get(password) ?? []).filter(
      (other) => other.id !== account.id,
    );
    if (shared.length > 0) issues.push("reused");

    const changedAt = passwordMethod(account)?.changedAt ?? "";
    if (Date.parse(changedAt) < cutoff) issues.push("old");
    if (!accountTotp(account)) issues.push("no-2fa");

    for (const issue of issues) counts[issue] += 1;
    if (issues.length > 0) {
      findings.push({
        item: account,
        issues,
        sharedWith: shared.map(
          (other) => other.name || hostOf(other.uris[0]?.uri),
        ),
        bits: strength.bits,
      });
    }
  }

  findings.sort((a, b) => b.issues.length - a.issues.length || a.bits - b.bits);

  return {
    findings,
    scored: accounts.length,
    clean: accounts.length - findings.length,
    unchecked,
    counts,
  };
}
