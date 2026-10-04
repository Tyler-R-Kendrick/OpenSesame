/**
 * The tutorial library: every walkthrough the product has, by what you want
 * to do, each one a replayable lesson.
 *
 * One row is one tutorial and starting it is the row's only action — the
 * title is the choice, the step count is its length, the glyph is its
 * direction. Replaying is starting again: nothing remembers that a tutorial
 * was run, because the transcript is memory and only memory (ADR 0088).
 */

import {
  FEATURES,
  shown,
} from "@opensesame/app-core/lib/capabilities/features.js";
import {
  type TutorialGroup,
  tutorialLibrary,
} from "@opensesame/app-core/tutorial/registry/areas.js";
import { registerGuidePredicates } from "@opensesame/app-core/tutorial/registry/predicates.js";
import { readGuidePredicate } from "@opensesame/app-core/tutorial/registry/state.js";
import { type ReactElement, useMemo } from "react";
import { useComposition } from "../../bindings/capabilities.js";
import { useConnectorRoads } from "../../bindings/connector-roads.js";
import { IconPlay } from "../../components/Icons.js";
import { featureDraws } from "../../sections/settings/provider-tile-items.js";
import type { SupportController } from "../session.js";

/** The library, narrowed to titles that contain `query` (blank keeps all). */
export function filterLibrary(
  groups: readonly TutorialGroup[],
  query: string,
): readonly TutorialGroup[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return groups;
  return groups
    .map((group) => ({
      ...group,
      tutorials: group.tutorials.filter((entry) =>
        `${entry.goal.title} ${group.title}`.toLowerCase().includes(needle),
      ),
    }))
    .filter((group) => group.tutorials.length > 0);
}

export function SupportTutorials({
  query,
  route,
  support,
}: {
  query: string;
  route: string;
  support: SupportController;
}): ReactElement {
  // A tutorial that points at a section of Settings › Capabilities is offered
  // only where that section is drawn: in this build, under this plan.
  const { plan } = useComposition();
  const roads = useConnectorRoads();
  const groups = useMemo(() => {
    // Idempotent: the engine declares the same set when it loads.
    registerGuidePredicates();
    const drawn = new Set(
      FEATURES.filter((feature) =>
        featureDraws(shown(feature, plan), roads.tile, plan),
      ).map((feature) => String(feature.id)),
    );
    return filterLibrary(
      tutorialLibrary(route, {
        sectionDrawn: (id) => drawn.has(id),
        holds: readGuidePredicate,
      }),
      query,
    );
  }, [query, route, plan, roads]);
  return (
    <section className="support__library" aria-label="Tutorials">
      {groups.length === 0 ? (
        <p className="hint">Nothing written matches that yet.</p>
      ) : null}
      {groups.map((group) => (
        <div key={group.id} className="support__group">
          <h3 className="support__section-label">{group.title}</h3>
          <ul className="support__tutorials">
            {group.tutorials.map(({ goal, steps }) => (
              <li key={goal.id}>
                <button
                  type="button"
                  className="support__tutorial"
                  data-tutorial={goal.id}
                  onClick={() =>
                    void support.startGuide(goal.guide, "authored")
                  }
                >
                  <span className="support__tutorial-title">{goal.title}</span>
                  <span className="support__tutorial-steps">
                    {steps} {steps === 1 ? "step" : "steps"}
                  </span>
                  <IconPlay size={14} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
