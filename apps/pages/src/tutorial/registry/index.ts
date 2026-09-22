/**
 * The semantic registries: what a guide may point at, where it may go, and
 * what it may wait on. Everything the tutorial system knows about this app
 * enters through here, and nothing enters by reading the DOM.
 */

export {
  CORE_GUIDE_TARGETS,
  GUIDE_TARGETS,
  mergedGuideTargets,
} from "./catalog.js";
export { buildSupportPageContext, type PageContextInput } from "./context.js";
export {
  CAPABILITY_TUTORIALS,
  CORE_GUIDE_GOALS,
  CORE_HELP_TOPICS,
  GUIDE_GOALS,
  HELP_TOPICS,
  mergedGuideGoals,
  mergedHelpTopics,
  type GuideGoalDescriptor,
  type HelpTopic,
  type RankedHelpTopic,
  describeGuideGoals,
  guideGoal,
  guideGoalIds,
  helpTopicsForRoute,
  rankHelpTopics,
  searchHelpTopics,
} from "./goals.js";
export { GuideTarget, useGuideTarget } from "./react.jsx";
export {
  CORE_GUIDE_ROUTES,
  GUIDE_ROUTES,
  mergedGuideRoutes,
  type GuideRouteDescriptor,
  type GuideRouteId,
  describeGuideRoutes,
  guideRouteForPath,
  isKnownGuideRoute,
} from "./routes.js";
export {
  type GuidePredicateDescriptor,
  announceGuideStateChange,
  declareGuidePredicate,
  describeGuideState,
  guidePredicateIds,
  isKnownGuidePredicate,
  observeGuidePredicate,
  readGuidePredicate,
  resetGuidePredicatesForTest,
} from "./state.js";
export {
  type GuideTargetDescriptor,
  clearMountedGuideTargets,
  describeGuideTargets,
  duplicateGuideTargetMounts,
  guideTargetDescriptor,
  guideTargetDescriptors,
  guideTargetIds,
  isKnownGuideTarget,
  isMountedGuideTarget,
  mountGuideTarget,
  observeGuideTarget,
  resolveGuideTargetElement,
  subscribeToGuideTargets,
} from "./targets.js";
