import {
  type DeadmanPlan,
  type DeadmanStatus,
  commitDeadmanSwitch,
  deadmanStatusForUnlock,
  disarmDeadmanSwitch,
  prepareDeadmanSwitch,
  readDeadmanConfig,
} from "@opensesame/app-core/lib/deadman/index.js";
import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import type { VaultItem } from "@opensesame/vault-core";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { FailureNotice } from "../../../components/FailureNotice.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconKey } from "../../../components/IconKey.js";
import {
  IconCheck,
  IconCopy,
  IconPlus,
  IconTrash,
} from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useVault } from "../../../lib/vault/hooks.js";
import { MethodRow } from "./MethodRow.js";
import { SheetFrame } from "./SheetFrame.js";

const NOTICE_ID = "deadman-switch";

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

function ItemChoice({
  item,
  checked,
  busy,
  onToggle,
}: {
  item: VaultItem;
  checked: boolean;
  busy: boolean;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <label className="check deadman__item">
      <input
        type="checkbox"
        checked={checked}
        disabled={busy}
        onChange={(event) => onToggle(event.target.checked)}
      />
      <span>
        {item.name} <span className="deadman__kind">{item.kind}</span>
      </span>
    </label>
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

  function begin() {
    dismissNotice(NOTICE_ID);
    setSaid("");
    setError("");
    setPlan(null);
    setReleaseKey("");
    setStored(false);
    setSelected(new Set());
    setTimeoutDays(30);
    setRelayUrl(status?.relayUrl ?? "");
    setOpen(true);
  }

  async function prepare(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await prepareDeadmanSwitch({
        tomb,
        items,
        itemIds: [...selected],
        timeoutDays,
        relayUrl,
        webhookUrl,
        relayToken,
      });
      setPlan(next);
      setReleaseKey(next.releaseKey);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not prepare it.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!plan || !stored || busy) return;
    setBusy(true);
    setError("");
    try {
      await commitDeadmanSwitch(plan);
      setOpen(false);
      setSaid("Deadman switch is on.");
      setPlan(null);
      setReleaseKey("");
      refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not turn it on.",
      );
    } finally {
      setBusy(false);
    }
  }

  function disarm() {
    dismissNotice(NOTICE_ID);
    setBusy(true);
    setError("");
    void disarmDeadmanSwitch(tomb)
      .then(() => {
        setOpen(false);
        setSaid("Deadman switch is off.");
        setPlan(null);
        setReleaseKey("");
        refresh();
      })
      .catch((caught) => {
        setStatusNotice({
          id: NOTICE_ID,
          tone: "err",
          title: "Deadman switch",
          body:
            caught instanceof Error
              ? caught.message
              : "The relay did not confirm the change.",
        });
      })
      .finally(() => setBusy(false));
  }

  return (
    <section className="panel set__security" id="deadman-switch">
      <div className="panel__head">
        <div>
          <h2>Deadman switch</h2>
        </div>
      </div>
      <div className="panel__body">
        <output className="visually-hidden" aria-live="polite">
          {said}
        </output>
        <DeadmanRow
          status={status}
          busy={busy}
          onOpen={begin}
          onDisarm={disarm}
        />
      </div>
      {open ? (
        <SheetFrame
          title="Deadman switch"
          mark={<IconCheck size={20} />}
          busy={busy}
          onClose={() => {
            setOpen(false);
            setPlan(null);
            setReleaseKey("");
            setError("");
          }}
        >
          {plan ? (
            <div className="deadman__confirm">
              <h3>Store the release key first</h3>
              <p>
                The selected items are sealed under this key. It is not stored
                on this device, so losing it loses the release.
              </p>
              <code className="deadman__key">{releaseKey}</code>
              <IconKey
                label="Copy release key"
                small
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(releaseKey)
                    .catch(() => undefined);
                }}
              >
                <IconCopy size={16} />
              </IconKey>
              <label className="check">
                <input
                  type="checkbox"
                  checked={stored}
                  disabled={busy}
                  onChange={(event) => setStored(event.target.checked)}
                />
                <span>I stored the release key somewhere I can reach it.</span>
              </label>
              <FailureNotice
                id="deadman-switch:error"
                title="Deadman switch"
                message={error}
              />
              <FormCommit
                label="Turn on deadman switch"
                disabled={busy || !stored}
                busy={busy}
                onClick={() => void commit()}
              />
            </div>
          ) : (
            <form
              className="deadman__form"
              onSubmit={(event) => void prepare(event)}
            >
              <div className="field">
                <label htmlFor="deadman-timeout">Release after (days)</label>
                <input
                  id="deadman-timeout"
                  type="number"
                  min={1}
                  max={3650}
                  step={1}
                  value={timeoutDays}
                  disabled={busy}
                  onChange={(event) =>
                    setTimeoutDays(Number(event.target.value))
                  }
                />
              </div>
              <fieldset className="deadman__items">
                <legend title="A snapshot is taken now; later edits need a new arming.">
                  Items to release
                </legend>
                {choices.length === 0 ? (
                  <StatusMark
                    tone="idle"
                    label="No item in this vault can be released."
                  />
                ) : null}
                <div className="deadman__list">
                  {choices.map((item) => (
                    <ItemChoice
                      key={item.id}
                      item={item}
                      checked={selected.has(item.id)}
                      busy={busy}
                      onToggle={(checked) => {
                        setSelected((current) => {
                          const next = new Set(current);
                          if (checked) next.add(item.id);
                          else next.delete(item.id);
                          return next;
                        });
                      }}
                    />
                  ))}
                </div>
              </fieldset>
              <div className="field">
                <label htmlFor="deadman-relay">Relay endpoint</label>
                <input
                  id="deadman-relay"
                  type="url"
                  title="The relay must publish the signing key with the arm record and treat a missing heartbeat as the event."
                  autoComplete="off"
                  placeholder="https://relay.example/deadman"
                  value={relayUrl}
                  disabled={busy}
                  onChange={(event) => setRelayUrl(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="deadman-webhook">Trusted webhook</label>
                <input
                  id="deadman-webhook"
                  type="url"
                  autoComplete="off"
                  placeholder="https://your-agent.example/deadman"
                  value={webhookUrl}
                  disabled={busy}
                  onChange={(event) => setWebhookUrl(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="deadman-token">Relay token (optional)</label>
                <input
                  id="deadman-token"
                  type="password"
                  autoComplete="off"
                  value={relayToken}
                  disabled={busy}
                  onChange={(event) => setRelayToken(event.target.value)}
                />
              </div>
              <FailureNotice
                id="deadman-switch:error"
                title="Deadman switch"
                message={error}
              />
              <FormCommit
                label="Prepare release key"
                disabled={busy || selected.size === 0}
                busy={busy}
              />
            </form>
          )}
        </SheetFrame>
      ) : null}
    </section>
  );
}
