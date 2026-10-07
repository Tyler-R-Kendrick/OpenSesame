/**
 * What a walkthrough needs before it is offered, read the same way by the Ask
 * tab and the Tutorials tab: its sections of Settings › Capabilities are drawn
 * in this build under this plan, and its required state holds now. One gate,
 * so the two tabs cannot disagree about what is on offer.
 */

import {
  FEATURES,
  shown,
} from "@opensesame/app-core/lib/capabilities/features.js";
import type { LibraryOptions } from "@opensesame/app-core/tutorial/registry/areas.js";
import {
  provideGuideDeviceForm,
  provideGuideInstallOffer,
  provideGuideSupportModelPicks,
  registerGuidePredicates,
} from "@opensesame/app-core/tutorial/registry/predicates.js";
import { readGuidePredicate } from "@opensesame/app-core/tutorial/registry/state.js";
import { useMemo } from "react";
import { useComposition } from "../../bindings/capabilities.js";
import { useConnectorRoads } from "../../bindings/connector-roads.js";
import { installPanelDraws } from "../../lib/install-panel.js";
import { installState } from "../../lib/install.js";
import { useIdentityConfigured } from "../../lib/use-configured.js";
import { finePointerNow, narrowNow } from "../../lib/use-narrow.js";
import { featureDraws } from "../../sections/settings/provider-tile-items.js";

export function useTutorialGate(): LibraryOptions {
  const { plan } = useComposition();
  const roads = useConnectorRoads();
  // Settings › Capabilities draws a section against the same fact, so a
  // tutorial offered for a section is offered only where that section is.
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
    const drawn = new Set(
      FEATURES.filter((feature) =>
        featureDraws(shown(feature, plan, { identityApi }), roads.tile, plan, {
          identityApi,
        }),
      ).map((feature) => String(feature.id)),
    );
    return {
      sectionDrawn: (id: string) => drawn.has(id),
      holds: readGuidePredicate,
      installed: (id: string) => plan?.capabilities[id]?.approved === true,
    };
  }, [plan, roads, identityApi]);
}
