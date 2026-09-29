/**
 * A runtime-installed plugin as a Settings file (ADR 0134; ADR 0150 §7):
 * `settings/capabilities/plugins/<id>.json`, what the paired daemon last said
 * about it. Read-only — the daemon's own `plugins.json` is the record, and
 * the one write a person makes from Pages is the plugin's switch in its
 * section, which goes to the daemon and comes back here on the next read.
 *
 * Listed only once the daemon has answered, so a device with no daemon
 * paired shows no file rather than an empty one.
 */

import type { PluginEntry } from "../../lib/plugins/catalog.js";
import type { PluginView } from "../../lib/plugins/session.js";
import type { VirtualFile, VirtualFileProvider } from "./virtual-files.js";

export const PLUGINS_DIRECTORY = "settings/capabilities/plugins";

export function pluginFilePath(plugin: PluginEntry): string {
  return `${PLUGINS_DIRECTORY}/${plugin.id}.json`;
}

/** What the file is drawn from: the plugin's session. */
export type PluginFilesSession = Readonly<{
  plugin: PluginEntry;
  view(): PluginView;
  ensure(): void;
}>;

const READ_ONLY = "This file is read-only.";

/** The file's text: the plugin's state as the daemon reported it. */
export function pluginFileText(plugin: PluginEntry, view: PluginView): string {
  const state = view.state;
  const document = {
    id: plugin.id,
    kind: plugin.kind,
    capability: plugin.capability,
    installed: state?.installed ?? false,
    version: state?.version ?? null,
    enabled: state?.enabled ?? false,
    forced_off: state?.forcedOff ?? false,
    active: state?.active ?? false,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function pluginFiles(session: PluginFilesSession): VirtualFileProvider {
  const path = pluginFilePath(session.plugin);
  const file: VirtualFile = {
    path,
    language: "json",
    readOnly: true,
    removable: false,
    readOnlyLabel: "Kept by the daemon; read-only",
  };
  return {
    list: () => {
      // Listed while Settings renders: the read starts after that render,
      // never inside it.
      queueMicrotask(session.ensure);
      return session.view().read ? [file] : [];
    },
    read: async (asked) => {
      if (asked !== path || !session.view().read)
        throw new Error(`No file at ${asked}.`);
      return pluginFileText(session.plugin, session.view());
    },
    check: () => ({ ok: false, message: READ_ONLY }),
    write: async () => ({ ok: false, message: READ_ONLY }),
    remove: async () => ({ ok: false, message: READ_ONLY }),
  };
}
