/**
 * Who approved a persisted evidence slot, and where (docs/evidence/README.md).
 * The evidence gate (through `validateSlot`) and the promoter both apply this
 * one rule, so a manifest the promoter writes is one the gate accepts, and a
 * placeholder such as "pending review" passes neither.
 */
import { decodeJsonText } from "./json-text.mjs";

/** The repository whose reviews approve its evidence. */
export const EVIDENCE_REPOSITORY = "OpenSesame-Labs/OpenSesame";

// GitHub's login rule: 1 to 39 letters, digits and single hyphens, with no
// hyphen at either end.
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u;

// Words that stand in for a reviewer nobody named. Compared without case, with
// hyphens, underscores and spaces read as one space.
const PLACEHOLDERS = new Set([
  "pending",
  "pending review",
  "tbd",
  "tba",
  "todo",
  "none",
  "n/a",
  "na",
  "unknown",
  "null",
  "undefined",
  "reviewer",
  "approver",
]);

// A review, a review comment or a conversation comment on a pull request.
const PULL_FRAGMENT =
  /^(?:pullrequestreview-\d+|issuecomment-\d+|discussion_r\d+|r\d+)$/u;
const ISSUE_FRAGMENT = /^issuecomment-\d+$/u;
const NUMBER = /^[1-9]\d*$/u;

function required(value, label) {
  const text = decodeJsonText(
    value,
    `${label}: approval by and reference are required`,
  );
  if (!text.trim())
    throw new Error(`${label}: approval by and reference are required`);
  return text;
}

function quoted(text) {
  return JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}…` : text);
}

/** The reviewer: a GitHub login, never a placeholder. */
export function assertApprovalBy(value, label) {
  const by = required(value, label);
  const word = by
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/gu, " ");
  if (PLACEHOLDERS.has(word) || !LOGIN.test(by))
    throw new Error(
      `${label}: approval.by must be the reviewer's GitHub login, not ${quoted(by)}`,
    );
  return by;
}

function refuseReference(label, reference) {
  return new Error(
    `${label}: approval.reference must be an https://github.com/${EVIDENCE_REPOSITORY} pull request, review or comment, not ${quoted(reference)}`,
  );
}

/** github.com itself over https, exactly as written: no port, user or query. */
function isGithubAddress(url, reference) {
  return (
    url.href === reference &&
    url.protocol === "https:" &&
    url.hostname === "github.com" &&
    !url.port &&
    !url.username &&
    !url.password &&
    !url.search
  );
}

/** A pull request, a review or comment on one, or a comment on an issue. */
function isRepositoryReview(url) {
  const [owner, repo, kind, number, ...rest] = url.pathname.slice(1).split("/");
  if (`${owner}/${repo}`.toLowerCase() !== EVIDENCE_REPOSITORY.toLowerCase())
    return false;
  if (!NUMBER.test(number ?? "")) return false;
  const fragment = url.hash.slice(1);
  if (kind === "issues")
    return rest.length === 0 && ISSUE_FRAGMENT.test(fragment);
  const page = rest.length === 0 || (rest.length === 1 && rest[0] === "files");
  return (
    kind === "pull" && page && (fragment === "" || PULL_FRAGMENT.test(fragment))
  );
}

/** Where it was approved: a pull request, review or comment of this repository. */
export function assertApprovalReference(value, label) {
  const reference = required(value, label);
  let url;
  try {
    url = new URL(reference);
  } catch {
    throw refuseReference(label, reference);
  }
  if (!isGithubAddress(url, reference) || !isRepositoryReview(url))
    throw refuseReference(label, reference);
  return reference;
}

/**
 * Both halves of an approval, as the manifest and the promoter carry them. A
 * value with no `by` or `reference` string (a number, an array, a string) is
 * refused by `required`, which reads both without coercion.
 */
export function assertApproval(approval, label) {
  if (!approval)
    throw new Error(`${label}: approval by and reference are required`);
  return {
    by: assertApprovalBy(approval.by, label),
    reference: assertApprovalReference(approval.reference, label),
  };
}
