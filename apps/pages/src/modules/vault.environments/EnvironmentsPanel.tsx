/**
 * Settings › Vaults › Environments. Drawn only after `vault.environments`
 * is approved; the required control and the environment switch are absent
 * until then.
 */

import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import {
  ENVIRONMENTS_CAPABILITY,
  type EnvironmentItem,
  type EnvironmentPlan,
  type EnvironmentSnapshot,
  assignEnvironmentValue,
  enableVaultEnvironments,
  environmentKey,
  environmentSnapshot,
  markEnvironmentRequired,
  notifyMissingEnvironmentValues,
  renderEnvSchema,
  subscribeVaultEnvironments,
  switchEnvironment,
  vaultEnvironmentsEnabled,
} from "@opensesame/app-core/lib/vault/environments.js";
import type { VaultItem } from "@opensesame/vault-core";
import {
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconPlus } from "../../components/Icons.js";
import { useVault } from "../../lib/vault/hooks.js";

type PanelProps = Readonly<{
  plan: EnvironmentPlan;
  vaultId: string;
  items: readonly EnvironmentItem[];
}>;

function itemKey(item: VaultItem): EnvironmentItem | null {
  const key = environmentKey(item.name);
  if (item.deletedAt !== null || key.length === 0) return null;
  return { id: item.id, key };
}

export function LiveEnvironmentsPanel() {
  const vault = useVault();
  const plan = useSyncExternalStore(
    compositionStore.subscribe,
    () => compositionStore.getSnapshot().plan,
  );
  const items = useMemo(
    () =>
      vault.items.flatMap((item) => {
        const next = itemKey(item);
        return next === null ? [] : [next];
      }),
    [vault.items],
  );
  return <EnvironmentsPanel plan={plan} vaultId={vault.tomb} items={items} />;
}

export function EnvironmentsPanel({ plan, vaultId, items }: PanelProps) {
  const state = useSyncExternalStore(subscribeVaultEnvironments, () =>
    environmentSnapshot(vaultId),
  );
  // The snapshot readers close over the record, so `state` retriggers them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: state retriggers schema and notice
  useLayoutEffect(() => {
    if (plan?.approvedCapabilities.includes(ENVIRONMENTS_CAPABILITY)) {
      enableVaultEnvironments(plan, vaultId, items);
      renderEnvSchema(plan, vaultId, items);
    }
    notifyMissingEnvironmentValues(plan, vaultId, items);
  }, [plan, vaultId, items, state]);
  if (!vaultEnvironmentsEnabled(plan, vaultId)) return null;
  return (
    <section
      id="vault-environments"
      className="panel"
      aria-label="Environments"
    >
      <div className="panel__head">
        <h2>Environments</h2>
      </div>
      <div className="panel__body">
        <EnvironmentSwitch
          plan={plan}
          vaultId={vaultId}
          names={state.names}
          active={state.active}
        />
        {/* A value is held for a named environment: with none, a row would be
            a disabled box and an input that cannot take text (ADR 0158). */}
        {state.active === null ? null : (
          <ul>
            {items.map((item) => (
              <EnvironmentItemRow
                key={item.id}
                plan={plan}
                vaultId={vaultId}
                item={item}
                state={state}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function EnvironmentSwitch({
  plan,
  vaultId,
  names,
  active,
}: Omit<PanelProps, "items"> &
  Readonly<{ names: readonly string[]; active: string | null }>) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const name = draft.trim();
    if (name.length === 0) return;
    switchEnvironment(plan, vaultId, name);
    setDraft("");
  };
  return (
    <div className="field">
      {names.length === 0 ? null : (
        <>
          <label htmlFor="vault-environment">Environment</label>
          <select
            id="vault-environment"
            value={active ?? ""}
            onChange={(event) => {
              switchEnvironment(plan, vaultId, event.target.value);
            }}
          >
            {active === null ? <option value="" /> : null}
            {names.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </>
      )}
      <input
        aria-label="Environment name"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") add();
        }}
      />
      <IconKey label="Add environment" onClick={add}>
        <IconPlus size={16} />
      </IconKey>
    </div>
  );
}

function EnvironmentItemRow({
  plan,
  vaultId,
  item,
  state,
}: Omit<PanelProps, "items"> &
  Readonly<{ item: EnvironmentItem; state: EnvironmentSnapshot }>) {
  const active = state.active;
  const required =
    active !== null && state.required[active]?.[item.id] === true;
  const value = active === null ? "" : (state.values[active]?.[item.id] ?? "");
  return (
    <li>
      <label>
        <input
          type="checkbox"
          aria-label={`${item.key} required`}
          checked={required}
          onChange={(event) => {
            if (active === null) return;
            markEnvironmentRequired(
              plan,
              vaultId,
              active,
              item.id,
              event.target.checked,
            );
          }}
        />
        {item.key}
      </label>
      <input
        aria-label={`${item.key} value`}
        value={value}
        onChange={(event) => {
          if (active === null) return;
          assignEnvironmentValue(
            plan,
            vaultId,
            active,
            item.id,
            event.target.value,
          );
        }}
      />
    </li>
  );
}
