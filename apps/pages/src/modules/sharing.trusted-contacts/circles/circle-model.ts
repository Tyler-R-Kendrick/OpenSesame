/**
 * The owner's forms as plain data (ADR 0187 §10): what a person types for a
 * circle's rule and clocks, turned into the inputs the desk takes, and the
 * desk's refusals turned back into the field they belong to. Pure, so every
 * edge of a form can be read without drawing one.
 *
 * Nothing here reads a key, a share or a packet. A refusal of an unsaved draft
 * is a mark on its field, never a notice: it is not a failure, it is a form
 * that is not finished.
 */

import {
  DEFAULT_TIMING,
  type Preview,
  type RuleInput,
  type TimingInput,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import type { PolicyWarning } from "@opensesame/app-core/lib/quorum/policy.js";
import type { CirclePolicy } from "@opensesame/app-core/lib/quorum/types.js";
import { folderQuery } from "@opensesame/app-core/lib/vault/path-suggest.js";
import { sentence } from "../failure-text.js";

export type Person = Readonly<{ id: string; name: string }>;

/** What a circle protects: the whole vault, one folder, or nothing but approvals. */
export type Protects = "everything" | "folder" | "approvals";

export const PROTECTS: readonly Readonly<{ id: Protects; label: string }>[] = [
  { id: "everything", label: "Everything in this vault" },
  { id: "folder", label: "A folder" },
  { id: "approvals", label: "Approvals only" },
];

/** The collection a whole-vault circle names; a folder's circle names the folder. */
export const WHOLE_VAULT = "Everything";
export const APPROVALS_ONLY = "Approvals only";

export function collectionOf(protects: Protects, folder: string): string {
  if (protects === "approvals") return APPROVALS_ONLY;
  return protects === "folder" ? folder : WHOLE_VAULT;
}

/** What a circle protects, and the folder when it is one. */
export type Scope = Readonly<{ protects: Protects; folder: string }>;

/**
 * What a saved circle protects, read back from the collection it names. A
 * collection that is not the whole vault is a folder, whether or not the
 * folder is still there: a circle never widens to the whole vault because a
 * folder was renamed.
 */
export function protectsOf(
  recovers: boolean,
  collection: string,
  folderNames: readonly string[],
): Scope {
  if (!recovers) return { protects: "approvals", folder: "" };
  if (collection === WHOLE_VAULT) return { protects: "everything", folder: "" };
  const wanted = folderQuery(collection).toLowerCase();
  const named = folderNames.find((name) => name.toLowerCase() === wanted);
  return { protects: "folder", folder: named ?? collection };
}

// ─── The rule ────────────────────────────────────────────────────────────────

export type Side = "A" | "B";

export type RuleDraft = Readonly<{
  /** Two groups, each with its own number needed. */
  second: boolean;
  /** Which group each contact sits in; read only when `second`. */
  sides: Readonly<Record<string, Side>>;
  /** How many of each group, as typed. */
  needed: Readonly<{ A: string; B: string }>;
  /** How many groups must be satisfied, when there are two. */
  groupsNeeded: 1 | 2;
}>;

/** A form field that can carry a refusal. */
export type Field =
  | "needed"
  | "needed-b"
  | "groups"
  | "members"
  | "minutes"
  | "hours"
  | "days"
  | "step";

export type Issue = Readonly<{ field: Field; message: string }>;

/** Half of them, rounded up, once there are three; everyone while there are fewer. */
export function defaultNeeded(count: number): number {
  return count < 3 ? Math.max(1, count) : Math.ceil(count / 2);
}

export function defaultRule(people: readonly Person[]): RuleDraft {
  return {
    second: false,
    sides: Object.fromEntries(people.map((p) => [p.id, "A" as const])),
    needed: { A: String(defaultNeeded(people.length)), B: "1" },
    groupsNeeded: 2,
  };
}

function sameIds(rule: RuleDraft, people: readonly Person[]): boolean {
  const known = Object.keys(rule.sides);
  return (
    known.length === people.length && people.every((p) => p.id in rule.sides)
  );
}

/** The rule as it stands for these people: kept if they are the same people, `fresh` otherwise. */
export function reconcileRule(
  rule: RuleDraft | null,
  people: readonly Person[],
  fresh: (people: readonly Person[]) => RuleDraft = defaultRule,
): RuleDraft {
  return rule && sameIds(rule, people) ? rule : fresh(people);
}

/** One group becomes two: the people split down the middle, both groups needed. */
export function withSecondGroup(
  rule: RuleDraft,
  people: readonly Person[],
): RuleDraft {
  const half = Math.ceil(people.length / 2);
  return {
    ...rule,
    second: true,
    sides: Object.fromEntries(
      people.map((p, index) => [p.id, index < half ? "A" : "B"] as const),
    ),
    needed: {
      A: String(defaultNeeded(half)),
      B: String(defaultNeeded(people.length - half)),
    },
    groupsNeeded: 2,
  };
}

export function withOneGroup(
  rule: RuleDraft,
  people: readonly Person[],
): RuleDraft {
  return {
    ...rule,
    second: false,
    sides: Object.fromEntries(people.map((p) => [p.id, "A" as const])),
    needed: { ...rule.needed, A: String(defaultNeeded(people.length)) },
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/** A circle's saved rule, laid over the people who are in it now. Newcomers join the first group. */
export function ruleFromPolicy(
  policy: CirclePolicy,
  people: readonly Person[],
): RuleDraft {
  const [first, other] = policy.groups;
  if (!first) return defaultRule(people);
  const inOther = new Set(other?.guardianIds ?? []);
  const sides = Object.fromEntries(
    people.map((p) => [p.id, inOther.has(p.id) ? "B" : "A"] as const),
  );
  const count = (side: Side) =>
    people.filter((p) => sides[p.id] === side).length;
  const second = policy.groups.length === 2 && count("A") > 0 && count("B") > 0;
  return {
    second,
    sides,
    needed: {
      A: String(clamp(first.threshold, 1, second ? count("A") : people.length)),
      B: String(clamp(other?.threshold ?? 1, 1, count("B"))),
    },
    groupsNeeded: policy.groupThreshold === 1 ? 1 : 2,
  };
}

const WHOLE = /^\d{1,6}$/;

/** A whole number as typed, or `null`. */
export function wholeNumber(text: string): number | null {
  return WHOLE.test(text.trim()) ? Number(text.trim()) : null;
}

export type RuleParse =
  | Readonly<{ ok: true; rule: RuleInput }>
  | Readonly<{ ok: false; issues: readonly Issue[] }>;

function neededIssue(field: Field, text: string): Issue | null {
  const n = wholeNumber(text);
  return n !== null && n >= 1 && n <= 16
    ? null
    : { field, message: "Needed is a whole number, 1 to 16." };
}

/** The desk's rule input from the form, or what in the form is not yet a number. */
export function ruleInput(
  rule: RuleDraft,
  people: readonly Person[],
): RuleParse {
  const ids = (side: Side) =>
    people.filter((p) => rule.sides[p.id] === side).map((p) => p.id);
  if (!rule.second) {
    const issue = neededIssue("needed", rule.needed.A);
    if (issue) return { ok: false, issues: [issue] };
    return {
      ok: true,
      rule: {
        groups: [
          {
            id: "All",
            threshold: Number(rule.needed.A.trim()),
            guardianIds: people.map((p) => p.id),
          },
        ],
        groupThreshold: 1,
      },
    };
  }
  const issues = [
    neededIssue("needed", rule.needed.A),
    neededIssue("needed-b", rule.needed.B),
    ids("A").length === 0 || ids("B").length === 0
      ? { field: "members" as const, message: "Put someone in each group." }
      : null,
  ].filter((issue): issue is Issue => issue !== null);
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    rule: {
      groups: [
        {
          id: "A",
          threshold: Number(rule.needed.A.trim()),
          guardianIds: ids("A"),
        },
        {
          id: "B",
          threshold: Number(rule.needed.B.trim()),
          guardianIds: ids("B"),
        },
      ],
      groupThreshold: rule.groupsNeeded,
    },
  };
}

// ─── The clocks ──────────────────────────────────────────────────────────────

export type ClocksDraft = Readonly<{
  minutes: string;
  hours: string;
  days: string;
  verify: boolean;
}>;

export function clocksOf(timing: TimingInput): ClocksDraft {
  return {
    minutes: String(Math.round(timing.approvalWindowSec / 60)),
    hours: String(Math.round(timing.releaseDelaySec / 3600)),
    days: String(Math.round(timing.requestLifetimeSec / 86400)),
    verify: timing.requireUserVerification,
  };
}

export const DEFAULT_CLOCKS: ClocksDraft = clocksOf(DEFAULT_TIMING);

/** What the policy's schema allows, in the units the form asks in. */
const RANGES = {
  minutes: { low: 1, high: 10_080, label: "Minutes" },
  hours: { low: 0, high: 2_160, label: "Hours" },
  days: { low: 1, high: 120, label: "Days" },
} as const;

function clockIssue(
  field: "minutes" | "hours" | "days",
  text: string,
): Issue | null {
  const { low, high, label } = RANGES[field];
  const n = wholeNumber(text);
  return n !== null && n >= low && n <= high
    ? null
    : { field, message: `${label} is ${low} to ${high.toLocaleString("en")}.` };
}

export type ClocksParse =
  | Readonly<{ ok: true; timing: TimingInput }>
  | Readonly<{ ok: false; issues: readonly Issue[] }>;

export function parseClocks(clocks: ClocksDraft): ClocksParse {
  const issues = [
    clockIssue("minutes", clocks.minutes),
    clockIssue("hours", clocks.hours),
    clockIssue("days", clocks.days),
  ].filter((issue): issue is Issue => issue !== null);
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    timing: {
      approvalWindowSec: Number(clocks.minutes.trim()) * 60,
      releaseDelaySec: Number(clocks.hours.trim()) * 3600,
      requestLifetimeSec: Number(clocks.days.trim()) * 86400,
      requireUserVerification: clocks.verify,
    },
  };
}

// ─── What the desk said about the draft ──────────────────────────────────────

export type Review = Readonly<{
  issues: readonly Issue[];
  warnings: readonly PolicyWarning[];
}>;

export const NOTHING_TO_REVIEW: Review = { issues: [], warnings: [] };

function fieldOfRefusal(code: string, message: string): Field {
  switch (code) {
    case "member_threshold":
      return message.includes("group B") ? "needed-b" : "needed";
    case "member_threshold_one":
      return "needed";
    case "group_threshold":
      return "groups";
    case "duplicate_guardian":
    case "guardian_in_two_groups":
    case "group_membership":
      return "members";
    case "lifetime":
      return message.includes("approval window") ? "minutes" : "days";
    default:
      return "step";
  }
}

/** The desk's verdict on a draft: the field that is wrong, or what a careful owner would still want to hear. */
export function review(preview: Preview): Review {
  if (preview.ok) return { issues: [], warnings: preview.warnings };
  return {
    issues: [
      {
        field: fieldOfRefusal(preview.code, preview.message),
        message: sentence(preview.message),
      },
    ],
    warnings: [],
  };
}

const RULE_FIELDS: ReadonlySet<Field> = new Set([
  "needed",
  "needed-b",
  "groups",
  "members",
  "step",
]);

/** What the desk said that the rule can answer: the clocks have their own step. */
export function ruleSide(verdict: Review): Review {
  return {
    issues: verdict.issues.filter((issue) => RULE_FIELDS.has(issue.field)),
    warnings: verdict.warnings,
  };
}

/** The first issue on `field`, from any of the lists. */
export function issueOn(
  field: Field,
  ...lists: readonly (readonly Issue[])[]
): string | null {
  for (const list of lists) {
    const found = list.find((issue) => issue.field === field);
    if (found) return found.message;
  }
  return null;
}

// ─── A contact ───────────────────────────────────────────────────────────────

/** A custody domain for a contact: one the owner named, or one of their own. */
export function custodyDomainOf(
  household: string,
  fresh: () => string,
): string {
  const slug = household
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug === "" ? `solo-${fresh()}` : `home-${slug}`;
}
