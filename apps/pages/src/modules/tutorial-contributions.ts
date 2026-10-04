/**
 * Tutorial descriptors a module contributes are authored, checked-in prose
 * kept beside the registry (`tutorial/registry/<capability>-catalog.ts`,
 * `-goals.ts`), never written inside a runtime and never interpolated
 * (ADR 0088). A module only says which authored arrays are live while it is
 * active; the core registry declares them for `mountGuideTarget`, GuideLang
 * `navigate` and the support page context, and forgets them on revoke.
 */

import type { GuideGoalDescriptor } from "@opensesame/app-core/tutorial/registry/goals.js";
import type { GuideRouteDescriptor } from "@opensesame/app-core/tutorial/registry/routes.js";
import type { GuideTargetDescriptor } from "@opensesame/app-core/tutorial/registry/targets.js";
import type { RegistrationHandle } from "@opensesame/capability-composition";
import type { Activation } from "./activation.js";

export type TutorialContributions = Readonly<{
  targets?: readonly GuideTargetDescriptor[];
  goals?: readonly GuideGoalDescriptor[];
  routes?: readonly GuideRouteDescriptor[];
}>;

/**
 * Declare the authored arrays for as long as the activation lives. The handles
 * come back for a module whose page comes and goes (Notifications, with an
 * Identity API): it revokes them with the page, so a walkthrough never points
 * at a route that is not there.
 */
export function registerTutorial(
  activation: Activation,
  contributions: TutorialContributions,
): readonly RegistrationHandle[] {
  return [
    ...(contributions.targets ?? []).map((target) =>
      activation.register("tutorial-target", target),
    ),
    ...(contributions.goals ?? []).map((goal) =>
      activation.register("tutorial-goal", goal),
    ),
    ...(contributions.routes ?? []).map((route) =>
      activation.register("tutorial-route", route),
    ),
  ];
}
