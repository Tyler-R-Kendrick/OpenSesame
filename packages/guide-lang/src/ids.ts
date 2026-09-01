/**
 * Semantic identifiers GuideLang is allowed to name.
 *
 * These are deliberately plain string aliases, matching `PrincipalId` and the
 * rest of `@opensesame/os-domain`. A branded type would only move the check to
 * compile time, and GuideLang is parsed from a *model-authored string* at
 * runtime — the type system was never going to be the boundary here. The
 * validators below are the boundary, and the runtime re-checks membership
 * against the live registries before anything reaches the DOM.
 */

/** A named end state a trajectory is working towards, e.g. `connection.create`. */
export type GuideGoalId = string;

/** A registered semantic control, e.g. `nav.connections`. Never a selector. */
export type GuideTargetId = string;

/** A registered in-app route, e.g. `/connections`. Never an arbitrary URL. */
export type GuideRouteId = string;

/** A registered coarse state predicate, e.g. `vault.unlocked`. */
export type GuidePredicateId = string;

/**
 * Dotted lower-case segments. Deliberately excludes `#`, `.` as a leading
 * character, `>`, `[`, `:`, `/` and whitespace, so no CSS selector, XPath
 * expression or URL can ever satisfy it.
 */
const SEMANTIC_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/** Absolute, single-origin-relative app paths only. */
const ROUTE_ID =
  /^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*)?$/;

export const MAX_SEMANTIC_ID_CHARS = 64;
export const MAX_ROUTE_ID_CHARS = 64;

export function isGuideSemanticId(value: string): boolean {
  return value.length <= MAX_SEMANTIC_ID_CHARS && SEMANTIC_ID.test(value);
}

export function isGuideGoalId(value: string): value is GuideGoalId {
  return isGuideSemanticId(value);
}

export function isGuideTargetId(value: string): value is GuideTargetId {
  return isGuideSemanticId(value);
}

export function isGuidePredicateId(value: string): value is GuidePredicateId {
  return isGuideSemanticId(value);
}

/**
 * Route syntax. Membership in the app's route registry is a *separate* check
 * (`validateAgainstVocabulary`) — passing this does not make a route safe, it
 * only makes it structurally incapable of being `javascript:`, `//evil.example`,
 * `../../etc`, `http://…` or a data URL.
 */
export function isGuideRouteId(value: string): value is GuideRouteId {
  return (
    value.length <= MAX_ROUTE_ID_CHARS &&
    !value.startsWith("//") &&
    !value.includes("..") &&
    ROUTE_ID.test(value)
  );
}
