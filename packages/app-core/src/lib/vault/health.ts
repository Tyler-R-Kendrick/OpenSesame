import {
  type AccountItem,
  type CredentialItem,
  type ProducedPassword,
  type VaultItem,
  accountTotp,
  completePassword,
  hostOf,
  passwordMethod,
  produceAccountPassword,
  producePassword,
} from "@opensesame/vault-core";
import { estimateStrength } from "./password.js";

export type HealthIssue = "weak" | "reused" | "old" | "no-2fa";

export type HealthFinding = {
  item: AccountItem | CredentialItem;
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
   * Accounts whose password has a slot for a pepper only the person has, or
   * was made by an older version: health neither asks nor scores them (ADR 0174).
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

/** One password the report scores: an account's, or a credential kept on its own. */
type Subject = {
  item: AccountItem | CredentialItem;
  produced: ProducedPassword;
  changedAt: string;
  /** Null for a credential: there is no account for a second step to protect. */
  hasTotp: boolean | null;
  /** Read only when another password is reused with this one. */
  label: () => string;
};

function subjectsOf(items: readonly VaultItem[]): Subject[] {
  const accounts = new Set(
    items
      .filter((item) => item.kind === "account" && item.deletedAt === null)
      .map((item) => item.id),
  );
  return items.flatMap((item): Subject[] => {
    if (item.deletedAt !== null) return [];
    if (item.kind === "account") {
      return [
        {
          item,
          produced: produceAccountPassword(item),
          changedAt: passwordMethod(item)?.changedAt ?? "",
          hasTotp: accountTotp(item) !== "",
          label: () => item.name || hostOf(item.uris[0]?.uri),
        },
      ];
    }
    // A password bound to an account is scored with that account.
    if (item.kind !== "credential" || item.method.type !== "password")
      return [];
    if (item.accountId !== null && accounts.has(item.accountId)) return [];
    return [
      {
        item,
        produced: producePassword(item.method),
        changedAt: item.method.changedAt,
        hasTotp: null,
        label: () => item.name,
      },
    ];
  });
}

export function buildHealthReport(items: VaultItem[]): HealthReport {
  const live = subjectsOf(items);
  // Scored on the whole password the facade produces. One missing a pepper
  // only the person has, or made by an older version, cannot be scored.
  const wholeOf = (subject: Subject) =>
    completePassword(subject.produced) ?? "";
  const scoredSubjects = live.filter((subject) => wholeOf(subject) !== "");
  const unchecked = live.filter(
    ({ produced }) =>
      produced.status === "slotted" || produced.status === "legacy",
  ).length;

  const byPassword = new Map<string, Subject[]>();
  for (const subject of scoredSubjects) {
    const password = wholeOf(subject);
    const bucket = byPassword.get(password);
    if (bucket) bucket.push(subject);
    else byPassword.set(password, [subject]);
  }

  const cutoff = Date.now() - OLD_PASSWORD_DAYS * 86_400_000;
  const counts = {
    weak: 0,
    reused: 0,
    old: 0,
    "no-2fa": 0,
  };
  const findings: HealthFinding[] = [];

  for (const subject of scoredSubjects) {
    const password = wholeOf(subject);
    const issues: HealthIssue[] = [];
    const strength = estimateStrength(password);
    if (strength.score <= 1) issues.push("weak");

    const shared = (byPassword.get(password) ?? []).filter(
      (other) => other.item.id !== subject.item.id,
    );
    if (shared.length > 0) issues.push("reused");

    if (Date.parse(subject.changedAt) < cutoff) issues.push("old");
    if (subject.hasTotp === false) issues.push("no-2fa");

    for (const issue of issues) counts[issue] += 1;
    if (issues.length > 0) {
      findings.push({
        item: subject.item,
        issues,
        sharedWith: shared.map((other) => other.label()),
        bits: strength.bits,
      });
    }
  }

  findings.sort((a, b) => b.issues.length - a.issues.length || a.bits - b.bits);

  return {
    findings,
    scored: scoredSubjects.length,
    clean: scoredSubjects.length - findings.length,
    unchecked,
    counts,
  };
}

/**
 * What Password health shows for breach and two-step checks.
 *
 * The check runs in `security-checks.ts` and only while `vault.security-checks`
 * is on. This seat stays in the core vault library, so the health page can
 * read it without loading that module. `off` is the value while the capability
 * is off, and the page draws nothing for it.
 */
export type BreachWatchLine = Readonly<{
  id: string;
  name: string;
  site: string;
  breaches: number;
  twoFactorAvailable: boolean;
  /** Sentences a person can read without hovering a status mark. */
  sentences: readonly string[];
}>;

export type BreachWatch =
  | Readonly<{ phase: "off" }>
  | Readonly<{ phase: "idle"; label: string }>
  | Readonly<{ phase: "checking"; label: string }>
  | Readonly<{ phase: "error"; label: string }>
  | Readonly<{
      phase: "checked";
      label: string;
      checked: number;
      breached: number;
      twoStep: number;
      fingerprint: string;
      lines: readonly BreachWatchLine[];
    }>;

const BREACH_WATCH_OFF: BreachWatch = { phase: "off" };

type BreachWatchSlot = {
  current: BreachWatch;
  listeners: Set<() => void>;
};

const breachWatchSlot: BreachWatchSlot = {
  current: BREACH_WATCH_OFF,
  listeners: new Set(),
};

export function breachWatchSnapshot(): BreachWatch {
  return breachWatchSlot.current;
}

export function subscribeBreachWatch(listener: () => void): () => void {
  breachWatchSlot.listeners.add(listener);
  return () => {
    breachWatchSlot.listeners.delete(listener);
  };
}

/** Replace the seat. Listeners re-read `breachWatchSnapshot`. */
export function publishBreachWatch(next: BreachWatch): void {
  breachWatchSlot.current = next;
  for (const listener of breachWatchSlot.listeners) listener();
}
