/**
 * Test fixture: registers every optional tutorial partition the way the
 * capability modules do on activation, so a suite that walks the whole
 * authored corpus keeps its coverage (EVID-08) while the default view stays
 * core-only. Returns the revoke for all of it.
 */

import { registerContributionForTest } from "../../lib/contributions.js";
import { registerLegacySettingsCategories } from "../../lib/contributions.test-support.js";
import { OPTIONAL_TUTORIALS, type TutorialPartition } from "./authored.js";

export function registerTutorialPartition(
  partition: TutorialPartition,
): () => void {
  const revokes = [
    ...partition.targets.map((target) =>
      registerContributionForTest("tutorial-target", target),
    ),
    ...partition.goals.map((goal) =>
      registerContributionForTest("tutorial-goal", goal),
    ),
    ...partition.routes.map((route) =>
      registerContributionForTest("tutorial-route", route),
    ),
  ];
  return () => {
    for (const revoke of revokes) revoke();
  };
}

export function registerOptionalTutorials(): () => void {
  const revokes = OPTIONAL_TUTORIALS.map(registerTutorialPartition);
  return () => {
    for (const revoke of revokes) revoke();
  };
}

/**
 * Every optional partition *and* the Settings categories the same modules
 * contribute — `/settings/connections` is a guide route because the
 * connectors capability contributes that category, not because any catalog
 * authors it twice. What a tutorial suite needs to see the whole corpus.
 */
export function registerTutorialRealm(): () => void {
  const revokes = [
    registerOptionalTutorials(),
    registerLegacySettingsCategories(),
  ];
  return () => {
    for (const revoke of revokes) revoke();
  };
}
