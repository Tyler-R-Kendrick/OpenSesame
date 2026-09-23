import type { ConnectorSetting } from "@opensesame/app-core/lib/connector-settings.js";
import {
  SHARE_DURATIONS,
  SHARE_POLICIES,
} from "@opensesame/app-core/lib/local-share-grants.js";
import { type FormEvent, useState } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconCheck, IconX } from "../../components/Icons.js";

/** The bind defaults: policy and duration the row's bind form opens with. */
function DefaultsFields({
  policy,
  duration,
  onPolicy,
  onDuration,
}: {
  policy: string;
  duration: number;
  onPolicy: (policy: string) => void;
  onDuration: (seconds: number) => void;
}) {
  return (
    <div className="access-bind__fields">
      <div className="field">
        <label className="label" htmlFor="connector-policy">
          Bind policy
        </label>
        <select
          id="connector-policy"
          value={policy}
          onChange={(event) => onPolicy(event.target.value)}
        >
          {SHARE_POLICIES.connection.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor="connector-duration">
          Bind duration
        </label>
        <select
          id="connector-duration"
          value={duration}
          onChange={(event) => onDuration(Number(event.target.value))}
        >
          {SHARE_DURATIONS.map((entry) => (
            <option key={entry.seconds} value={entry.seconds}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/**
 * One connector's local configuration: the name the rows show, whether it
 * binds at all, and the policy and duration its bind form opens with.
 * Nothing here touches a credential — there is no field for one.
 */
export function ConnectorSettingsForm({
  connector,
  initial,
  busy,
  onCancel,
  onSave,
}: {
  connector: string;
  initial: ConnectorSetting;
  busy: boolean;
  onCancel: () => void;
  onSave: (setting: ConnectorSetting) => void;
}) {
  const [alias, setAlias] = useState(initial.alias);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [policy, setPolicy] = useState(initial.defaultPolicy);
  const [duration, setDuration] = useState(initial.defaultDurationSeconds);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSave({
      alias: alias.trim(),
      enabled,
      defaultPolicy: policy,
      defaultDurationSeconds: duration,
    });
  }

  return (
    <form className="access-bind" onSubmit={submit}>
      <fieldset disabled={busy}>
        <legend>Configure {connector}</legend>
        <div className="field">
          <label className="label" htmlFor="connector-alias">
            Display name
          </label>
          <input
            id="connector-alias"
            type="text"
            autoComplete="off"
            maxLength={64}
            placeholder={connector}
            value={alias}
            onChange={(event) => setAlias(event.target.value)}
          />
        </div>
        <div className="field">
          <label className="check" htmlFor="connector-enabled">
            <input
              id="connector-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <span>Enabled — allow new binds</span>
          </label>
        </div>
        <DefaultsFields
          policy={policy}
          duration={duration}
          onPolicy={setPolicy}
          onDuration={setDuration}
        />
        <FormCommit label="Save">
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Cancel"
            title="Cancel"
            onClick={onCancel}
          >
            <IconX size={16} />
          </button>
        </FormCommit>
      </fieldset>
    </form>
  );
}
