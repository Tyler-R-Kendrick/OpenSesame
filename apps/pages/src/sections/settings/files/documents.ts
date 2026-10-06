/**
 * Which files a settings address names are the page itself.
 *
 * A directory's own `config.yaml` and the capability documents behind
 * Capabilities are real files in the virtual tree, and the rail, the command
 * bar and an old link all open them by path. Their view is the designed page
 * that writes them, the same as every other page in the app: opening one
 * draws that page, never its text. Only a file a provider keeps for authoring
 * (an item type's JSON, a routing file) opens in the file viewer.
 */
import {
  EFFECTIVE_FILE,
  POLICY_FILE,
  SELECTION_FILE,
} from "@opensesame/app-core/sections/settings/capability-files.js";
import {
  SETTINGS_CONFIG_FILE,
  settingsFilePath,
} from "@opensesame/app-core/sections/settings/settings-files.js";

const CAPABILITY_DOCUMENTS: ReadonlySet<string> = new Set([
  SELECTION_FILE,
  POLICY_FILE,
  EFFECTIVE_FILE,
]);

/** Whether `file`, opened in `category`, is a page's document. */
export function isSettingsDocument(category: string, file: string): boolean {
  return (
    file === SETTINGS_CONFIG_FILE ||
    file === settingsFilePath(category) ||
    (category === "capabilities" && CAPABILITY_DOCUMENTS.has(file))
  );
}
