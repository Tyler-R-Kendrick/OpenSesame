import {
  SHARE_DURATIONS,
  SHARE_POLICIES,
} from "@opensesame/app-core/lib/local-share-grants.js";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { IconCheck, IconX } from "../../components/Icons.js";
import type { BindInput, ConnectorIdentity } from "./useConnectorDirectory.js";

type Choice = { id: string | number; label: string };

function BindSelect({
  id,
  label,
  value,
  choices,
  selectRef,
  onChange,
}: {
  id: string;
  label: string;
  value: string | number;
  choices: readonly Choice[];
  selectRef?: React.RefObject<HTMLSelectElement | null>;
  onChange: (value: string) => void;
}): ReactNode {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        ref={selectRef}
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {choices.map((choice) => (
          <option key={String(choice.id)} value={choice.id}>
            {choice.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Bind one connector to one identity: who, under which policy, until when.
 * The connector is already decided by the row this opens under, so the form
 * is three native selects and a commit — the PAM decision, nothing else.
 */
export function ConnectorBindForm({
  connector,
  identities,
  busy,
  initialPolicy,
  initialDuration,
  onCancel,
  onBind,
}: {
  connector: string;
  identities: readonly ConnectorIdentity[];
  busy: boolean;
  initialPolicy?: string;
  initialDuration?: number;
  onCancel: () => void;
  onBind: (input: BindInput) => void;
}) {
  const [principalId, setPrincipalId] = useState(identities[0]?.id ?? "");
  const [policy, setPolicy] = useState<string>(
    initialPolicy ?? SHARE_POLICIES.connection[0]?.id ?? "use",
  );
  const [duration, setDuration] = useState<number>(
    initialDuration ?? SHARE_DURATIONS[0].seconds,
  );
  const first = useRef<HTMLSelectElement>(null);
  // The keyboard lands on the first choice — unless a finger opened this,
  // where a form is not focused uninvited (DESIGN.md › Touch).
  useEffect(() => {
    if (window.matchMedia?.("(pointer: coarse)").matches) return;
    first.current?.focus();
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!principalId) return;
    onBind({ principalId, policy, durationSeconds: duration });
  }

  if (identities.length === 0) {
    return (
      <fieldset className="access-bind" disabled={busy}>
        <legend>Bind {connector}</legend>
        <p>No person or agent in this vault yet. Create one under Identity.</p>
        <div className="actions">
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Close"
            title="Close"
            onClick={onCancel}
          >
            <IconX size={16} />
          </button>
        </div>
      </fieldset>
    );
  }

  return (
    <form className="access-bind" onSubmit={submit}>
      <fieldset disabled={busy}>
        <legend>Bind {connector}</legend>
        <div className="access-bind__fields">
          <BindSelect
            id="bind-identity"
            label="Identity"
            value={principalId}
            selectRef={first}
            choices={identities.map((entry) => ({
              id: entry.id,
              label: entry.name,
            }))}
            onChange={setPrincipalId}
          />
          <BindSelect
            id="bind-policy"
            label="Policy"
            value={policy}
            choices={SHARE_POLICIES.connection}
            onChange={setPolicy}
          />
          <BindSelect
            id="bind-duration"
            label="Duration"
            value={duration}
            choices={SHARE_DURATIONS.map((entry) => ({
              id: entry.seconds,
              label: entry.label,
            }))}
            onChange={(value) => setDuration(Number(value))}
          />
        </div>
        <div className="actions">
          <button
            type="submit"
            className="icon-btn icon-btn--sm"
            aria-label="Bind"
            title="Bind"
          >
            <IconCheck size={16} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Cancel"
            title="Cancel"
            onClick={onCancel}
          >
            <IconX size={16} />
          </button>
        </div>
      </fieldset>
    </form>
  );
}
