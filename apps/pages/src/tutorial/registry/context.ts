/**
 * Builds the semantic page context a support model is allowed to see.
 *
 * This is the privacy boundary in one function. It assembles the context from
 * authored registries — targets, routes, predicates, goals, and the ADR-0065
 * capability list — and from nothing else. It does not read `innerText`, form
 * values, vault records, notices, storage or the DOM, so there is no path by
 * which a secret can arrive here to be leaked further on.
 */

import { CAPABILITIES } from "@opensesame/capability-registry";
import type {
  SupportCapabilityDescription,
  SupportHelpEntry,
  SupportPageContext,
  SupportToolDescription,
} from "@opensesame/support-agent";
import { SUPPORT_LIMITS } from "@opensesame/support-agent";
import {
  isWebMcpToolExposed,
  webmcpRegistrationSnapshot,
} from "../../webmcp/registration.js";
import { inDevelopment } from "./dev.js";
import { describeGuideGoals, rankHelpTopics } from "./goals.js";
import {
  type GuideRouteId,
  describeGuideRoutes,
  isKnownGuideRoute,
} from "./routes.js";
import { describeGuideState } from "./state.js";
import { describeGuideTargets } from "./targets.js";

/**
 * Capability titles are registry prose, and `available` is derived from the
 * app's own plane status — never from a permission the model asked about.
 */
function describeCapabilities(
  hostReachable: boolean,
  identityReachable: boolean,
): readonly SupportCapabilityDescription[] {
  const out: SupportCapabilityDescription[] = [];
  for (const capability of CAPABILITIES) {
    if (capability.surfaces.pwa === null) continue;
    const available =
      capability.plane === "host"
        ? hostReachable
        : capability.plane === "identity"
          ? identityReachable
          : true;
    out.push({ id: capability.id, title: capability.title, available });
  }
  return withinBudget(out, SUPPORT_LIMITS.maxCapabilities, "capabilities");
}

/**
 * Trims an authored list to its model budget — loudly, where a developer is
 * watching.
 *
 * Every list here is authored in this repository, so outgrowing a budget is
 * our mistake rather than a caller's, and it is the kind that hides: the ADR
 * 0065 capability list grows with every merge, and a silent `slice` means the
 * newest capability simply stops being mentioned to the model, with no test
 * red and nothing logged. Registry faults of this kind already stop a
 * developer — a target declared twice throws — so this one does too.
 *
 * A person's session is never worth breaking over it, so a production build
 * still trims and carries on. The deliberate asymmetry is with
 * `@opensesame/support-agent`'s egress sanitizer, which trims the same lists
 * silently and must keep doing so: that boundary exists to bound whatever it
 * is handed, and throwing there would turn oversized input into a crash.
 */
function withinBudget<T>(
  list: readonly T[],
  limit: number,
  what: string,
): readonly T[] {
  if (list.length <= limit) return list;
  if (inDevelopment()) {
    throw new Error(
      `support_context_budget_exceeded:${what}:${list.length}>${limit}`,
    );
  }
  return list.slice(0, limit);
}

/**
 * The written help worth showing a model for this question: the best lexical
 * matches, in rank order, with their authored prose. Without a question there
 * is nothing to retrieve against, and the model is told so.
 */
function describeHelp(
  question: string | undefined,
  route: GuideRouteId,
): readonly SupportHelpEntry[] {
  if (question === undefined || question.trim().length === 0) return [];
  return rankHelpTopics(question, route)
    .slice(0, SUPPORT_LIMITS.maxHelpEntries)
    .map(({ topic }) => ({
      id: topic.id,
      title: topic.title,
      answer: topic.answer,
      goal: topic.goal,
    }));
}

/**
 * The WebMCP tools this page holds registered right now — the app's own
 * account of what it implements, read from the registration store rather than
 * from a static list, so a locked vault reports its boot tools and nothing
 * else. Descriptions are the ones the page registers; `exposed` says whether
 * this browser's agent can actually see the tool.
 */
function describeTools(): readonly SupportToolDescription[] {
  const out: SupportToolDescription[] = [];
  for (const tool of webmcpRegistrationSnapshot().implemented) {
    out.push({
      name: tool.name,
      description: tool.description,
      exposed: isWebMcpToolExposed(tool.name),
    });
  }
  return withinBudget(out, SUPPORT_LIMITS.maxTools, "tools");
}

export type PageContextInput = {
  readonly pageId: string;
  readonly route: GuideRouteId;
  readonly hostReachable: boolean;
  readonly identityReachable: boolean;
  /** The question being asked, when there is one; it selects the written help. */
  readonly question?: string;
};

/**
 * The adversarial sweep noted that `route` arrived as a caller-supplied string:
 * bounded in length by the egress sanitizer, but never checked for membership.
 * It was correct only because the one live caller passes `guideRouteForPath`,
 * which is proven total onto the registry — a call-site convention rather than
 * a contract. Checking it here makes the guarantee the function's own, so an
 * unregistered route can never reach a model as though the app were on it.
 */
function knownRouteOrVault(route: GuideRouteId): GuideRouteId {
  return isKnownGuideRoute(route) ? route : "/vault";
}

export function buildSupportPageContext(
  input: PageContextInput,
): SupportPageContext {
  const route = knownRouteOrVault(input.route);
  return {
    version: 1,
    pageId: input.pageId,
    route,
    targets: withinBudget(
      describeGuideTargets(route),
      SUPPORT_LIMITS.maxTargets,
      "targets",
    ),
    routes: withinBudget(
      describeGuideRoutes(),
      SUPPORT_LIMITS.maxRoutes,
      "routes",
    ),
    state: withinBudget(
      describeGuideState(),
      SUPPORT_LIMITS.maxStateFacts,
      "state",
    ),
    capabilities: describeCapabilities(
      input.hostReachable,
      input.identityReachable,
    ),
    goals: withinBudget(
      describeGuideGoals(route),
      SUPPORT_LIMITS.maxGoals,
      "goals",
    ),
    help: describeHelp(input.question, route),
    tools: describeTools(),
  };
}
