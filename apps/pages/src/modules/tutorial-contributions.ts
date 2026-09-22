/**
 * Tutorial descriptors a module contributes are authored, checked-in prose
 * kept beside the registry (`tutorial/registry/<capability>-catalog.ts`,
 * `-goals.ts`), never written inside a runtime and never interpolated
 * (ADR 0088). A module only says which authored arrays are live while it is
 * active; the core registry declares them for `mountGuideTarget`, GuideLang
 * `navigate` and the support page context, and forgets them on revoke.
 */

import type { GuideGoalDescriptor } from "../tutorial/registry/goals.js";
import type { GuideRouteDescriptor } from "../tutorial/registry/routes.js";
import type { GuideTargetDescriptor } from "../tutorial/registry/targets.js";
import type { Activation } from "./activation.js";

export type TutorialContributions = Readonly<{
  targets?: readonly GuideTargetDescriptor[];
  goals?: readonly GuideGoalDescriptor[];
  routes?: readonly GuideRouteDescriptor[];
}>;

export function registerTutorial(
  activation: Activation,
  contributions: TutorialContributions,
): void {
  for (const target of contributions.targets ?? []) {
    activation.register("tutorial-target", target);
  }
  for (const goal of contributions.goals ?? []) {
    activation.register("tutorial-goal", goal);
  }
  for (const route of contributions.routes ?? []) {
    activation.register("tutorial-route", route);
  }
}
