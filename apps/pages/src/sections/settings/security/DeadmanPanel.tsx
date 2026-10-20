import {
  type DeadmanPlan,
  type DeadmanStatus,
  deadmanStatusForUnlock,
  readDeadmanConfig,
} from "@opensesame/app-core/lib/deadman/index.js";
import { useEffect, useMemo, useState } from "react";
import { IconKey } from "../../../components/IconKey.js";
import { IconPlus, IconTrash } from "../../../components/Icons.js";
import { useVault } from "../../../lib/vault/hooks.js";
import { DeadmanPanelView } from "./DeadmanPanelView.js";
import { MethodRow } from "./MethodRow.js";
import {
  type DeadmanPanelModel,
  beginDeadmanPanel,
  createDeadmanActions,
} from "./deadman-panel-actions.js";

function daysPhrase(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

function remainingPhrase(status: DeadmanStatus): string {
  const days = Math.ceil(status.remainingMs / 86_400_000);
  return days <= 0 ? "the deadline has passed" : `${daysPhrase(days)} remain`;
}

/** Whether the panel draws: the owner of an open vault, never a guest. */
export function useDeadmanPanelShown(): boolean {
  const { guest, status } = useVault();
  return !guest && status === "unlocked";
}

function DeadmanRow({
  status,
  busy,
  onOpen,
  onDisarm,
}: {
  status: DeadmanStatus | null;
  busy: boolean;
  onOpen: () => void;
  onDisarm: () => void;
}) {
  const armed = Boolean(status);
  return (
    <MethodRow
      kind="deadman"
      label="Deadman switch"
      state={status?.damaged ? "Damaged" : armed ? "On" : "Off"}
      on={armed && !status?.damaged}
      tone={status?.damaged ? "warn" : status?.triggered ? "warn" : undefined}
      sub={
        status
          ? status.damaged
            ? "The signed record did not verify. Nothing can be released."
            : status.triggered
              ? "The deadline passed. The release screen is on the lock screen."
              : `Releases after ${daysPhrase(status.timeoutDays)} without an unlock — ${remainingPhrase(status)}. This device only; the relay sees a schedule, a hash and a public key, never an item.`
          : "Release chosen items after a run of days without an unlock on this device. The relay sees a schedule, a hash and a public key, never an item."
      }
      action={
        <div className="deadman__actions">
          {armed ? (
            <IconKey label="Turn off" small disabled={busy} onClick={onDisarm}>
              <IconTrash size={16} />
            </IconKey>
          ) : (
            <IconKey label="Add" small disabled={busy} onClick={onOpen}>
              <IconPlus size={16} />
            </IconKey>
          )}
        </div>
      }
    />
  );
}

export function DeadmanPanel() {
  const shown = useDeadmanPanelShown();
  const { items, tomb } = useVault();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<DeadmanStatus | null>(() =>
    deadmanStatusForUnlock(tomb),
  );
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const [error, setError] = useState("");
  const [plan, setPlan] = useState<DeadmanPlan | null>(null);
  const [releaseKey, setReleaseKey] = useState("");
  const [stored, setStored] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [timeoutDays, setTimeoutDays] = useState<number>(30);
  const [relayUrl, setRelayUrl] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [relayToken, setRelayToken] = useState("");
  const choices = useMemo(
    () =>
      items.filter((item) => item.deletedAt === null && item.kind !== "drop"),
    [items],
  );
  const refresh = () => setStatus(deadmanStatusForUnlock(tomb));
  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);
  useEffect(() => {
    setStatus(deadmanStatusForUnlock(tomb));
    if (!open) return;
    let live = true;
    void readDeadmanConfig(tomb)
      .then((config) => {
        if (!live || !config) return;
        setRelayToken(config.relayToken);
        setWebhookUrl(config.webhookUrl);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open, tomb]);
  if (!shown) return null;
  const model: DeadmanPanelModel = {
    tomb,
    items,
    open,
    status,
    busy,
    said,
    error,
    plan,
    releaseKey,
    stored,
    selected,
    timeoutDays,
    relayUrl,
    webhookUrl,
    relayToken,
    setOpen,
    setBusy,
    setSaid,
    setError,
    setPlan,
    setReleaseKey,
    setStored,
    setSelected,
    setTimeoutDays,
    setRelayUrl,
    setWebhookUrl,
    setRelayToken,
    refresh,
  };
  function begin() {
    beginDeadmanPanel(model);
  }
  const { prepare, commit, disarm } = createDeadmanActions(model);
  return (
    <DeadmanPanelView
      model={model}
      choices={choices}
      prepare={prepare}
      commit={commit}
      row={
        <DeadmanRow
          status={status}
          busy={busy}
          onOpen={begin}
          onDisarm={disarm}
        />
      }
    />
  );
}
