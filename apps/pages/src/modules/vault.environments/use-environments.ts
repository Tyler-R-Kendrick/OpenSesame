/**
 * What the Environments sheet reads and writes: the open vault's environments
 * and keys, the one environment in view, and an `edit` that reports a refusal
 * in the tray rather than painting it in the sheet (controls.md § 0).
 */

import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import type { EnvironmentsEdit } from "@opensesame/app-core/lib/vault/body-environments.js";
import {
  environmentInView,
  viewEnvironment,
  writeEnvironments,
} from "@opensesame/app-core/lib/vault/environments-write.js";
import {
  type EnvironmentPlan,
  type SchemaKey,
  renderEnvSchema,
  schemaKeys,
} from "@opensesame/app-core/lib/vault/environments.js";
import {
  type VaultItem,
  canBeKey,
  environmentNames,
  normalizeEnvironmentName,
} from "@opensesame/vault-core";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useVault } from "../../lib/vault/hooks.js";

function usePlan(): EnvironmentPlan {
  return useSyncExternalStore(
    compositionStore.subscribe,
    () => compositionStore.getSnapshot().plan,
  );
}

/** Where the sheet reads the plan; a test swaps it for one that approves. */
export const environmentSeams = { usePlan };

export type Environments = Readonly<{
  names: readonly string[];
  /** The environment whose values the sheet is showing, or null with none. */
  active: string | null;
  keys: readonly SchemaKey[];
  /** Items that could become keys: live, and not keys already. */
  candidates: readonly VaultItem[];
  schema: string;
  /** The last refusal; the sheet raises it in the tray (controls.md § 0). */
  failure: string | null;
  /** True while the name field's last answer was a refusal, so it can say so. */
  nameRefused: boolean;
  choose: (name: string) => void;
  /** True when the edit landed. */
  edit: (edit: EnvironmentsEdit) => Promise<boolean>;
  /** Add an environment from what was typed; false when it cannot be a name. */
  addEnvironment: (typed: string) => Promise<boolean>;
}>;

export function useEnvironments(): Environments {
  const vault = useVault();
  const plan = environmentSeams.usePlan();
  const names = useMemo(
    () => environmentNames(vault.environments),
    [vault.environments],
  );
  const keys = useMemo(() => schemaKeys(vault.items), [vault.items]);
  const candidates = useMemo(
    () => vault.items.filter((item) => canBeKey(item) && !item.environments),
    [vault.items],
  );
  const schema = useMemo(() => renderEnvSchema(names, keys), [names, keys]);
  const [viewed, setViewed] = useState<string | null>(() =>
    environmentInView(vault.tomb, names),
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [nameRefused, setNameRefused] = useState(false);
  const active =
    viewed !== null && names.includes(viewed) ? viewed : (names[0] ?? null);

  const choose = useCallback(
    (name: string) => {
      viewEnvironment(vault.tomb, name);
      setViewed(name);
    },
    [vault.tomb],
  );

  const edit = useCallback(
    async (next: EnvironmentsEdit): Promise<boolean> => {
      try {
        const result = await writeEnvironments(plan, next);
        setFailure(null);
        return result.ok;
      } catch (caught) {
        setFailure(
          caught instanceof Error
            ? caught.message
            : "The change was not saved.",
        );
        return false;
      }
    },
    [plan],
  );

  const addEnvironment = useCallback(
    async (typed: string): Promise<boolean> => {
      const name = normalizeEnvironmentName(typed);
      if (name === null) {
        setFailure(
          "An environment name is lower-case words joined by - _ or .",
        );
        setNameRefused(true);
        return false;
      }
      const landed = await edit({ op: "add-environment", name });
      setNameRefused(!landed);
      if (landed) choose(name);
      return landed;
    },
    [choose, edit],
  );

  return {
    names,
    active,
    keys,
    candidates,
    schema,
    failure,
    nameRefused,
    choose,
    edit,
    addEnvironment,
  };
}
