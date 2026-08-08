import { estimateStrength } from "./password.js";
import { hostOf, type LoginItem, type VaultItem } from "./model.js";

export type HealthIssue = "weak" | "reused" | "old" | "no-2fa";

export type HealthFinding = {
  item: LoginItem;
  issues: HealthIssue[];
  /** Other item names sharing this password, when reused. */
  sharedWith: string[];
  bits: number;
};

export type HealthReport = {
  findings: HealthFinding[];
  scored: number;
  clean: number;
  counts: Record<HealthIssue, number>;
};

const OLD_PASSWORD_DAYS = 365;

export const ISSUE_LABEL: Record<HealthIssue, string> = {
  weak: "Weak",
  reused: "Reused",
  old: "Over a year old",
  "no-2fa": "No 2FA",
};

export const ISSUE_EXPLANATION: Record<HealthIssue, string> = {
  weak: "Short or predictable enough to be guessed offline. Generate a replacement.",
  reused: "One breach elsewhere unlocks every account sharing this password.",
  old: "Rotate passwords you have held for more than a year.",
  "no-2fa": "This login has no authenticator secret stored.",
};

export function buildHealthReport(items: VaultItem[]): HealthReport {
  const logins = items.filter(
    (item): item is LoginItem =>
      item.kind === "login" && item.deletedAt === null && item.password !== "",
  );

  const byPassword = new Map<string, LoginItem[]>();
  for (const login of logins) {
    const bucket = byPassword.get(login.password);
    if (bucket) bucket.push(login);
    else byPassword.set(login.password, [login]);
  }

  const cutoff = Date.now() - OLD_PASSWORD_DAYS * 86_400_000;
  const counts: Record<HealthIssue, number> = {
    weak: 0,
    reused: 0,
    old: 0,
    "no-2fa": 0,
  };
  const findings: HealthFinding[] = [];

  for (const login of logins) {
    const issues: HealthIssue[] = [];
    const strength = estimateStrength(login.password);
    if (strength.score <= 1) issues.push("weak");

    const shared = (byPassword.get(login.password) ?? []).filter(
      (other) => other.id !== login.id,
    );
    if (shared.length > 0) issues.push("reused");

    if (Date.parse(login.passwordChangedAt) < cutoff) issues.push("old");
    if (!login.totp) issues.push("no-2fa");

    for (const issue of issues) counts[issue] += 1;
    if (issues.length > 0) {
      findings.push({
        item: login,
        issues,
        sharedWith: shared.map((other) => other.name || hostOf(other.uris[0]?.uri)),
        bits: strength.bits,
      });
    }
  }

  findings.sort((a, b) => b.issues.length - a.issues.length || a.bits - b.bits);

  return {
    findings,
    scored: logins.length,
    clean: logins.length - findings.length,
    counts,
  };
}
