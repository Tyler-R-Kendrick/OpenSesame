/**
 * Breach and two-step checks for a vault's logins — what Enpass's
 * Watchtower and 1Password's Watchtower tell a person, without telling a
 * service anything about the vault (ADR 0080 §5's rules, in the browser):
 *
 *   - Breached passwords: Have I Been Pwned's Pwned Passwords range API,
 *     k-anonymity. Five hex characters of a password's SHA-1 leave the
 *     browser; the matching suffixes come back and are compared here, with
 *     padding asked for so the answer's size says nothing either.
 *   - Two-step sign-in: 2fa.directory's list of sites that take an
 *     authenticator code, fetched whole and matched here. No site name, URL
 *     or username is ever sent.
 *
 * Optional (`vault.security-checks`): nothing here runs until a person turns
 * the capability on and presses the check; its egress port is the only
 * fetch it is handed.
 */
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import {
  type AccountItem,
  type CredentialItem,
  type VaultItem,
  accountTotp,
  activeItems,
  completePassword,
  hostOf,
  produceAccountPassword,
  producePassword,
  unboundCredentials,
} from "@opensesame/vault-core";
import {
  type BreachWatch,
  type BreachWatchLine,
  publishBreachWatch,
} from "./health.js";

export const PWNED_RANGE_URL = "https://api.pwnedpasswords.com/range/";
export const TWO_FACTOR_LIST_URL = "https://api.2fa.directory/v3/totp.json";

export {
  PWNED_PURPOSE,
  TWO_FACTOR_PURPOSE,
} from "../capabilities/catalog-optional-vault.js";

export type CheckFetch = (url: string, init: RequestInit) => Promise<Response>;

export type SecurityFinding = {
  item: AccountItem | CredentialItem;
  /** Times the password appears in known breaches; 0 when it does not. */
  breaches: number;
  /** The site takes an authenticator code and this login stores none. */
  twoFactorAvailable: boolean;
};

export type SecurityReport = {
  checkedAt: string;
  /** Logins with a password, each checked. */
  checked: number;
  findings: SecurityFinding[];
};

/** Shown in Settings and on Password health while the capability is on and no check has finished. */
export const SECURITY_CHECKS_IDLE =
  "Breach and two-step checks on. Not checked.";

function noun(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The sentence Password health and Settings show for one finished check. */
export function securityWatchLabel(report: SecurityReport): string {
  const breached = report.findings.filter((f) => f.breaches > 0).length;
  const twoStep = report.findings.filter((f) => f.twoFactorAvailable).length;
  const checked = report.checked;
  if (breached > 0 && twoStep > 0) {
    return `${breached} of ${checked} passwords found in known breaches. ${noun(twoStep, "login", "logins")} could add an authenticator code.`;
  }
  if (breached > 0) {
    return `${breached} of ${checked} passwords found in known breaches.`;
  }
  if (twoStep > 0) {
    return `${noun(twoStep, "login", "logins")} of ${checked} could add an authenticator code.`;
  }
  return `${noun(checked, "login", "logins")} checked. No breaches; no missing codes.`;
}

/** Visible sentences for one login, breach first, then a missing authenticator code. */
export function findingSentences(
  breaches: number,
  twoFactorAvailable: boolean,
): string[] {
  const sentences: string[] = [];
  if (breaches > 0) {
    sentences.push(
      `Found in breaches ${noun(breaches, "time", "times")}: change this password`,
    );
  }
  if (twoFactorAvailable) {
    sentences.push("This site takes an authenticator code; none is stored");
  }
  return sentences;
}

function watchLine(finding: SecurityFinding): BreachWatchLine {
  const site =
    finding.item.kind === "account" ? hostOf(finding.item.uris[0]?.uri) : "";
  return {
    id: finding.item.id,
    name: finding.item.name,
    site,
    breaches: finding.breaches,
    twoFactorAvailable: finding.twoFactorAvailable,
    sentences: findingSentences(finding.breaches, finding.twoFactorAvailable),
  };
}

function checkedWatch(report: SecurityReport): BreachWatch {
  const breached = report.findings.filter((f) => f.breaches > 0).length;
  const twoStep = report.findings.filter((f) => f.twoFactorAvailable).length;
  return {
    phase: "checked",
    label: securityWatchLabel(report),
    checked: report.checked,
    breached,
    twoStep,
    lines: report.findings.map(watchLine),
  };
}

let checkedLoginFingerprint: string | null = null;

function loginFingerprint(items: readonly VaultItem[]): string {
  return logins(items)
    .map((item) => item.updatedAt)
    .sort()
    .join("|");
}

export type SecurityWatchNote =
  | { phase: "off" }
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "error"; message: string }
  | { phase: "checked"; report: SecurityReport };

/** Publish the standing Password health and the settings panel both read. */
export function noteSecurityWatch(note: SecurityWatchNote): void {
  switch (note.phase) {
    case "off":
      checkedLoginFingerprint = null;
      publishBreachWatch({ phase: "off" });
      return;
    case "idle":
      checkedLoginFingerprint = null;
      publishBreachWatch({ phase: "idle", label: SECURITY_CHECKS_IDLE });
      return;
    case "checking":
      publishBreachWatch({
        phase: "checking",
        label: "Checking logins for breaches and missing codes.",
      });
      return;
    case "error":
      publishBreachWatch({ phase: "error", label: note.message });
      return;
    case "checked":
      publishBreachWatch(checkedWatch(note.report));
      return;
  }
}

export function reconcileSecurityWatchWithVault(
  items: readonly VaultItem[],
): void {
  if (
    checkedLoginFingerprint !== null &&
    loginFingerprint(items) !== checkedLoginFingerprint
  ) {
    noteSecurityWatch({ phase: "idle" });
  }
}

/** Capability off: Password health drops the breach block. */
export function clearSecurityWatch(): void {
  noteSecurityWatch({ phase: "off" });
}

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .toUpperCase();
}

/** `SUFFIX:COUNT` lines; padding rows carry a count of 0. */
export function parseRange(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split(/\r?\n/u)) {
    const [suffix, count] = line.trim().split(":");
    const times = Number(count);
    if (suffix && Number.isSafeInteger(times) && times > 0)
      counts.set(suffix.toUpperCase(), times);
  }
  return counts;
}

/** How many times each password appears in known breaches. */
export async function breachCounts(
  passwords: readonly string[],
  fetchRange: CheckFetch,
): Promise<Map<string, number>> {
  const byPrefix = new Map<string, Map<string, string>>();
  for (const password of new Set(passwords)) {
    const hash = await sha1Hex(password);
    const prefix = hash.slice(0, 5);
    const bucket = byPrefix.get(prefix) ?? new Map<string, string>();
    bucket.set(hash.slice(5), password);
    byPrefix.set(prefix, bucket);
  }
  const counts = new Map<string, number>();
  for (const [prefix, bucket] of byPrefix) {
    const response = await fetchRange(`${PWNED_RANGE_URL}${prefix}`, {
      headers: { "Add-Padding": "true" },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`The breach check failed (${response.status}).`);
    }
    const range = parseRange(await response.text());
    for (const [suffix, password] of bucket) {
      counts.set(password, range.get(suffix) ?? 0);
    }
  }
  return counts;
}

/** Every domain 2fa.directory lists as taking an authenticator code. */
export function parseTwoFactorList(json: BoundaryValue): Set<string> {
  const domains = new Set<string>();
  if (!Array.isArray(json)) return domains;
  for (const entry of json) {
    const site = Array.isArray(entry) ? entry[1] : undefined;
    if (!isJsonObject(site)) continue;
    const named = [
      site.domain,
      ...(Array.isArray(site["additional-domains"])
        ? site["additional-domains"]
        : []),
    ];
    for (const domain of named) {
      if (isString(domain) && domain.trim() !== "")
        domains.add(domain.trim().toLowerCase());
    }
  }
  return domains;
}

/** `host` is `domain` or one of its subdomains. */
function within(host: string, domains: ReadonlySet<string>): boolean {
  const parts = host.toLowerCase().split(".");
  for (let start = 0; start < parts.length - 1; start += 1) {
    if (domains.has(parts.slice(start).join("."))) return true;
  }
  return false;
}

export async function fetchTwoFactorSites(
  fetchList: CheckFetch,
): Promise<Set<string>> {
  const response = await fetchList(TWO_FACTOR_LIST_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      `The two-step list could not be read (${response.status}).`,
    );
  }
  return parseTwoFactorList(await response.json());
}

/**
 * The whole password the account produces, when that needs nothing from the
 * person (ADR 0174); "" otherwise. A password completed by a pepper the
 * product never holds is not here to hash, so it is not checked.
 */
function wholePassword(item: AccountItem | CredentialItem): string {
  if (item.kind === "credential") {
    return item.method.type === "password"
      ? (completePassword(producePassword(item.method)) ?? "")
      : "";
  }
  return completePassword(produceAccountPassword(item)) ?? "";
}

/**
 * Live accounts whose whole password the product can produce, and passwords
 * kept on their own (ADR 0179): a breached password is as breached for no
 * account at all.
 */
function logins(items: readonly VaultItem[]): (AccountItem | CredentialItem)[] {
  const accounts = activeItems([...items]).filter(
    (item): item is AccountItem => item.kind === "account",
  );
  return [...accounts, ...unboundCredentials(items)].filter(
    (item) => wholePassword(item) !== "",
  );
}

/**
 * Check every live login with a password: once per distinct password prefix
 * against the breach corpus, and against the two-step list for those that
 * store no authenticator code. `fetchRange` and `fetchList` are the
 * capability's egress, one per declared purpose.
 */
export async function runSecurityChecks(
  items: readonly VaultItem[],
  fetchRange: CheckFetch,
  fetchList: CheckFetch,
  now: () => Date = () => new Date(),
): Promise<SecurityReport> {
  const checked = logins(items);
  const counts = await breachCounts(checked.map(wholePassword), fetchRange);
  const needCodes = checked.some(
    (login) => login.kind === "account" && !accountTotp(login),
  );
  const sites = needCodes
    ? await fetchTwoFactorSites(fetchList)
    : new Set<string>();
  const findings: SecurityFinding[] = [];
  for (const item of checked) {
    const breaches = counts.get(wholePassword(item)) ?? 0;
    const twoFactorAvailable =
      item.kind === "account" &&
      !accountTotp(item) &&
      item.uris.some((uri) => {
        const host = hostOf(uri.uri);
        return host !== "" && within(host, sites);
      });
    if (breaches > 0 || twoFactorAvailable)
      findings.push({ item, breaches, twoFactorAvailable });
  }
  findings.sort(
    (a, b) => b.breaches - a.breaches || a.item.name.localeCompare(b.item.name),
  );
  checkedLoginFingerprint = loginFingerprint(items);
  return {
    checkedAt: now().toISOString(),
    checked: checked.length,
    findings,
  };
}
