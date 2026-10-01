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
  activeEnvironment,
  assignEnvironmentValue,
  enableVaultEnvironments,
  environmentKey,
  environmentRequires,
  environmentSnapshot,
  markEnvironmentRequired,
  notifyMissingEnvironmentValues,
  readEnvironmentValue,
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
  useLayoutEffect(() => {
    if (!plan?.approvedCapabilities.includes(ENVIRONMENTS_CAPABILITY)) return;
    enableVaultEnvironments(plan, vaultId);
    notifyMissingEnvironmentValues(plan, vaultId, items);
  }, [plan, vaultId, items]);
  if (!vaultEnvironmentsEnabled(plan, vaultId)) return null;
  return (
    <section
      className="panel"
      id="vault-environments"
      aria-labelledby="vault-environments-title"
    >
      <div className="panel__head">
        <h2 id="vault-environments-title">Environments</h2>
      </div>
      <div className="panel__body">
        <EnvironmentSwitch
          plan={plan}
          vaultId={vaultId}
          names={state.names}
          active={state.active}
          items={items}
        />
        <ul>
          {items.map((item) => (
            <EnvironmentItemRow
              key={item.id}
              plan={plan}
              vaultId={vaultId}
              item={item}
              items={items}
              active={activeEnvironment(plan, vaultId)}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

function EnvironmentSwitch({
  plan,
  vaultId,
  names,
  active,
  items,
}: PanelProps & Readonly<{ names: readonly string[]; active: string | null }>) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const name = draft.trim();
    if (name.length === 0) return;
    switchEnvironment(plan, vaultId, name);
    setDraft("");
    notifyMissingEnvironmentValues(plan, vaultId, items);
  };
  return (
    <div className="field">
      <label htmlFor="vault-environment">Environment</label>
      <select
        id="vault-environment"
        value={active ?? ""}
        onChange={(event) => {
          switchEnvironment(plan, vaultId, event.target.value);
          notifyMissingEnvironmentValues(plan, vaultId, items);
        }}
      >
        {active === null ? <option value="" /> : null}
        {names.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
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
  items,
  active,
}: PanelProps & Readonly<{ item: EnvironmentItem; active: string | null }>) {
  const required =
    active !== null && environmentRequires(plan, vaultId, active, item.id);
  const value =
    active === null
      ? ""
      : (readEnvironmentValue(plan, vaultId, active, item.id) ?? "");
  const refresh = () => notifyMissingEnvironmentValues(plan, vaultId, items);
  return (
    <li>
      <label>
        <input
          type="checkbox"
          aria-label={`${item.key} required`}
          checked={required}
          disabled={active === null}
          onChange={(event) => {
            if (active === null) return;
            markEnvironmentRequired(
              plan,
              vaultId,
              active,
              item.id,
              event.target.checked,
            );
            refresh();
          }}
        />
        {item.key}
      </label>
      <input
        aria-label={`${item.key} value`}
        value={value}
        disabled={active === null}
        onChange={(event) => {
          if (active === null) return;
          assignEnvironmentValue(
            plan,
            vaultId,
            active,
            item.id,
            event.target.value,
          );
          refresh();
        }}
      />
    </li>
  );
}
