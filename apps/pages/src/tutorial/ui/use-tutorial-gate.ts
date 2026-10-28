/**
 * What a walkthrough needs before it is offered, read the same way by the Ask
 * tab and the Tutorials tab: its sections of Settings › Features and
 * Settings › Integrations are drawn
 * in this build under this plan, and its required state holds now. One gate,
 * so the two tabs cannot disagree about what is on offer.
 */

import {
  FEATURES,
  isSwitchable,
} from "@opensesame/app-core/lib/capabilities/features.js";
import type { LibraryOptions } from "@opensesame/app-core/tutorial/registry/areas.js";
import {
  provideGuideDeviceForm,
  provideGuideInstallOffer,
  provideGuideSupportModelPicks,
  registerGuidePredicates,
} from "@opensesame/app-core/tutorial/registry/predicates.js";
import { readGuidePredicate } from "@opensesame/app-core/tutorial/registry/state.js";
import {
  guideTargetVersion,
  subscribeToGuideTargets,
} from "@opensesame/app-core/tutorial/registry/targets.js";
import { useMemo, useSyncExternalStore } from "react";
import { useComposition } from "../../bindings/capabilities.js";
import { installPanelDraws } from "../../lib/install-panel.js";
import { installState } from "../../lib/install.js";
import { useIdentityConfigured } from "../../lib/use-configured.js";
import { finePointerNow, narrowNow } from "../../lib/use-narrow.js";
import { useIntegrationsDrawn } from "../../sections/settings/use-integrations-drawn.js";

export function useTutorialGate(): LibraryOptions {
  const targetVersion = useSyncExternalStore(
    subscribeToGuideTargets,
    guideTargetVersion,
    () => 0,
  );
  const { plan } = useComposition();
  const integrations = useIntegrationsDrawn();
  // Settings draws a section against the same facts, so a tutorial offered
  // for a section is offered only where that section is.
  const identityApi = useIdentityConfigured();
  return useMemo(() => {
    // Idempotent: the engine declares the same set when it loads.
    registerGuidePredicates();
    provideGuideInstallOffer(() => installPanelDraws(installState()));
    provideGuideDeviceForm(() => ({
      narrow: narrowNow(),
      keys: finePointerNow(),
    }));
    // The model tour points at picks the on-device model contributes. The
    // AI section stays drawn for WebMCP after that model is turned off.
    provideGuideSupportModelPicks(
      () => plan?.capabilities["support.local-ai"]?.approved === true,
    );
    // A tour names its section by target id: `feature.<id>` is a switch's
    // section, `integration.<id>` a third party's.
    const drawn = new Set([
      ...FEATURES.filter((feature) =>
        isSwitchable(feature, plan, { identityApi }),
      ).map((feature) => `feature.${feature.id}`),
      ...integrations.map(({ integration }) => `integration.${integration.id}`),
    ]);
    return {
      sectionDrawn: (id: string) => drawn.has(id),
      holds: readGuidePredicate,
      installed: (id: string) => plan?.capabilities[id]?.approved === true,
    };
  }, [plan, integrations, identityApi, targetVersion]);
}
