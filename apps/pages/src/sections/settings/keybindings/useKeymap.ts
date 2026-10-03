import {
  type KeymapCommand,
  keymapCommands,
} from "@opensesame/app-core/lib/keymap/commands.js";
import type { KeymapConfig } from "@opensesame/app-core/lib/keymap/config.js";
import type { KeymapContext } from "@opensesame/app-core/lib/keymap/context.js";
import { effectiveBindings } from "@opensesame/app-core/lib/keymap/effective.js";
import {
  loadKeymap,
  saveKeymap,
  subscribeKeymap,
} from "@opensesame/app-core/lib/keymap/store.js";
import {
  type KeymapScope,
  scopeContext,
} from "@opensesame/app-core/sections/settings/keymap-panel-model.js";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useContributions } from "../../../bindings/contributions.js";

export type KeymapState = Readonly<{
  config: KeymapConfig;
  commands: readonly KeymapCommand[];
  /** Who holds each key in `scope`. */
  bindings: ReadonlyMap<string, string>;
  /** Where recorded keys go: everywhere, or one listing (ADR 0156 §6). */
  scope?: KeymapContext;
  /** Keep a keymap; the message when it was refused. */
  save: (next: KeymapConfig) => string | null;
}>;

/** The keymap in force, redrawn when it or the plan's jumps change. */
export function useKeymap(): KeymapState {
  const config = useSyncExternalStore(subscribeKeymap, loadKeymap, loadKeymap);
  const jumps = useContributions("keymap-jump");
  const sections = useContributions("section");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the catalogue is read from the contributions these name
  const commands = useMemo(() => keymapCommands(), [jumps, sections]);
  // Who holds a key does not depend on the character-key switch: a key it
  // silenced is still that command's, and taking it is still a conflict.
  const bindings = useMemo(
    () => effectiveBindings({ ...config, singleKeys: true }, commands),
    [config, commands],
  );
  const save = useCallback((next: KeymapConfig) => {
    const result = saveKeymap(next);
    return result.ok ? null : result.message;
  }, []);
  return { config, commands, bindings, save };
}

/** The same keymap, read and written in one scope. */
export function useScopedKeymap(
  state: KeymapState,
  scope: KeymapScope,
): KeymapState {
  const context = scopeContext(scope);
  return useMemo(
    () =>
      context === undefined
        ? state
        : {
            ...state,
            scope: context,
            bindings: effectiveBindings(
              { ...state.config, singleKeys: true },
              state.commands,
              context,
            ),
          },
    [state, context],
  );
}
