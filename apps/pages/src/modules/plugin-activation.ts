/**
 * What a runtime-installed plugin's capability contributes when it is
 * activated (ADR 0150 §7): one session over the daemon it is handed, the
 * plugin's tile inside its Settings › Capabilities section, the file that
 * mirrors it (`settings/capabilities/plugins/<id>.json`, ADR 0134), and its
 * walkthrough.
 *
 * Shared by the two plugin modules, so it imports no optional code: the
 * daemon port comes from the module, which owns its egress. Nothing is sent
 * on activation; the tile asks when it is drawn, and only once a daemon is
 * paired.
 */

import type { PluginEntry } from "@opensesame/app-core/lib/plugins/catalog.js";
import type { PluginDaemon } from "@opensesame/app-core/lib/plugins/client.js";
import { createPluginSession } from "@opensesame/app-core/lib/plugins/session.js";
import { pluginFiles } from "@opensesame/app-core/sections/settings/plugin-files.js";
import { provideGuidePluginPanel } from "@opensesame/app-core/tutorial/registry/predicates.js";
import { createElement } from "react";
import { sectionCategory } from "../sections/settings/CapabilitySections.js";
import { notifySettingsFilesChanged } from "../sections/settings/files/revision.js";
import { PluginPanel } from "../sections/settings/plugins/PluginPanel.js";
import type { Activation } from "./activation.js";
import {
  type TutorialContributions,
  registerTutorial,
} from "./tutorial-contributions.js";

export type PluginContribution = Readonly<{
  plugin: PluginEntry;
  daemon: PluginDaemon;
  /** The FEATURES section the tile is drawn in (`feature-<id>`). */
  section: string;
  /** The tutorial target the tile is. */
  guideId: string;
  tutorial: TutorialContributions;
}>;

export function contributePlugin(
  activation: Activation,
  contribution: PluginContribution,
): void {
  const { plugin, daemon, section, guideId, tutorial } = contribution;
  const session = createPluginSession(plugin, daemon);
  activation.onDispose(() => session.dispose());
  // The file viewer lists from the same session: tell it when the view moves.
  activation.onDispose(session.subscribe(notifySettingsFilesChanged));
  // The panel is drawn with a daemon paired or the means to pair one
  // (`PluginPanel`); a walkthrough that points at it asks the same question.
  activation.onDispose(
    provideGuidePluginPanel(
      plugin.id,
      () => session.view().daemon !== null || session.canPair(),
    ),
  );
  const Panel = () => createElement(PluginPanel, { session, guideId });
  activation.register("settings-panel", {
    id: `plugin-${plugin.id}`,
    label: plugin.title,
    category: sectionCategory(section),
    Panel,
    order: 10,
    files: pluginFiles(session),
  });
  registerTutorial(activation, tutorial);
}
