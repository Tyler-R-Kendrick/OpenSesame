import type { VaultItem } from "@opensesame/vault-core";
import type { ReactNode } from "react";
import { FailureNotice } from "../../../components/FailureNotice.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconCheck, IconCopy } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { SheetFrame } from "./SheetFrame.js";
import type {
  DeadmanPanelModel,
  createDeadmanActions,
} from "./deadman-panel-actions.js";

type ViewProps = {
  model: DeadmanPanelModel;
  choices: VaultItem[];
  row: ReactNode;
  prepare: ReturnType<typeof createDeadmanActions>["prepare"];
  commit: ReturnType<typeof createDeadmanActions>["commit"];
};
type SheetProps = Omit<ViewProps, "row">;

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

function DeadmanItems({
  model,
  choices,
}: Pick<SheetProps, "model" | "choices">) {
  const { selected, busy, setSelected } = model;
  return (
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
  );
}

function DeadmanForm({
  model,
  choices,
  prepare,
}: Pick<SheetProps, "model" | "choices" | "prepare">) {
  const {
    timeoutDays,
    setTimeoutDays,
    busy,
    relayUrl,
    setRelayUrl,
    webhookUrl,
    setWebhookUrl,
    relayToken,
    setRelayToken,
    error,
    selected,
  } = model;
  return (
    <form className="deadman__form" onSubmit={(event) => void prepare(event)}>
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
          onChange={(event) => setTimeoutDays(Number(event.target.value))}
        />
      </div>
      <DeadmanItems model={model} choices={choices} />
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
  );
}

function DeadmanConfirmation({
  model,
  commit,
}: Pick<SheetProps, "model" | "commit">) {
  const { releaseKey, stored, busy, setStored, error } = model;
  return (
    <div className="deadman__confirm">
      <h3>Store the release key first</h3>
      <p>
        The selected items are sealed under this key. It is not stored on this
        device, so losing it loses the release.
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
  );
}

function DeadmanSheet({ model, choices, prepare, commit }: SheetProps) {
  const { busy, setOpen, setPlan, setReleaseKey, setError, plan } = model;
  return (
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
        <DeadmanConfirmation model={model} commit={commit} />
      ) : (
        <DeadmanForm model={model} choices={choices} prepare={prepare} />
      )}
    </SheetFrame>
  );
}

export function DeadmanPanelView({
  model,
  choices,
  prepare,
  commit,
  row,
}: ViewProps) {
  const { said, open } = model;
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
        {row}
      </div>
      {open ? (
        <DeadmanSheet
          model={model}
          choices={choices}
          prepare={prepare}
          commit={commit}
        />
      ) : null}
    </section>
  );
}
