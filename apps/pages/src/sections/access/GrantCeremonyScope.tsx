import { type FormEvent, useState } from "react";
import { IconAlert } from "../../components/Icons.js";
import type { Connection } from "../../lib/connections.js";
import {
  type GrantTarget,
  type ScopeInput,
  parseCsv,
  targetName,
} from "./grant-ceremony-types.js";

const DURATION_PRESETS: Array<{ label: string; seconds: number }> = [
  { label: "1h", seconds: 3_600 },
  { label: "8h", seconds: 28_800 },
  { label: "1d", seconds: 86_400 },
  { label: "1w", seconds: 604_800 },
];

export function ScopeStep({
  target,
  connection,
  connectionsReady,
  online,
  onBack,
  onScope,
}: {
  target: GrantTarget;
  connection: Connection | null;
  connectionsReady: boolean;
  online: boolean;
  onBack: () => void;
  onScope: (scope: ScopeInput) => void;
}) {
  const secret = target.kind === "secret" ? target.secret : null;
  const ceiling = secret?.ceiling ?? [];
  const ceilingActions = new Set(ceiling.map((grant) => grant.action));
  const ceilingResources = new Set(ceiling.map((grant) => grant.resource));

  const [actionsText, setActionsText] = useState(() =>
    [...ceilingActions].join(", "),
  );
  const [resourcesText, setResourcesText] = useState(() =>
    [...ceilingResources].join(", "),
  );
  const [mode, setMode] = useState<"broker" | "relay">("broker");
  const [preset, setPreset] = useState(3_600);
  const [customText, setCustomText] = useState("");

  const actions = parseCsv(actionsText);
  const resources = parseCsv(resourcesText);
  // A secret's scope may only ever narrow its ceiling — anything the ceiling
  // does not imply blocks the step (ADR 0019).
  const outside =
    secret === null
      ? []
      : [
          ...actions.filter((action) => !ceilingActions.has(action)),
          ...resources.filter((resource) => !ceilingResources.has(resource)),
        ];
  const customSeconds = Number(customText);
  const customValid =
    customText.trim() !== "" &&
    Number.isInteger(customSeconds) &&
    customSeconds > 0;
  const customInvalid = customText.trim() !== "" && !customValid;
  const expiresInSeconds = customValid ? customSeconds : preset;
  const unresolvable =
    secret !== null && connectionsReady && connection === null;
  const emptySecretScope =
    secret !== null && (actions.length === 0 || resources.length === 0);
  const blocked =
    outside.length > 0 || unresolvable || emptySecretScope || customInvalid;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (blocked) return;
    onScope({ actions, resources, executionMode: mode, expiresInSeconds });
  }

  return (
    <form onSubmit={submit}>
      <p className="access-ceremony__target">
        <strong>{targetName(target)}</strong>{" "}
        <code className="access-ref">
          {connection?.connectionRef ?? secret?.connectionRef ?? ""}
        </code>
      </p>

      {secret !== null ? (
        <div className="access-ceiling-context">
          <span className="access-secret__label">Ceiling</span>
          {ceiling.length > 0 ? (
            <span className="access-chips">
              {ceiling.map((grant) => (
                <span className="chip" key={grant.id}>
                  {grant.action} → {grant.resource}
                </span>
              ))}
            </span>
          ) : (
            <span className="hint">Empty.</span>
          )}
        </div>
      ) : null}

      <div className="field">
        <label className="label" htmlFor="grant-actions">
          Actions
        </label>
        <input
          id="grant-actions"
          value={actionsText}
          onChange={(event) => setActionsText(event.target.value)}
          placeholder="repository.read, repository.write"
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="grant-resources">
          Resources
        </label>
        <input
          id="grant-resources"
          value={resourcesText}
          onChange={(event) => setResourcesText(event.target.value)}
          placeholder="repo:acme/*"
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      <fieldset className="access-fieldset">
        <legend className="label">Execution mode</legend>
        <label className="access-radio">
          <input
            type="radio"
            name="grant-mode"
            value="broker"
            checked={mode === "broker"}
            onChange={() => setMode("broker")}
          />
          Broker
        </label>
        <label className="access-radio">
          <input
            type="radio"
            name="grant-mode"
            value="relay"
            checked={mode === "relay"}
            onChange={() => setMode("relay")}
          />
          Relay — each use needs approval
        </label>
      </fieldset>

      <fieldset className="access-fieldset">
        <legend className="label">Duration</legend>
        <div className="access-duration">
          {DURATION_PRESETS.map((option) => (
            <button
              key={option.seconds}
              type="button"
              className={`btn btn--sm${
                preset === option.seconds && customText.trim() === ""
                  ? " is-active"
                  : " btn--ghost"
              }`}
              aria-pressed={
                preset === option.seconds && customText.trim() === ""
              }
              onClick={() => {
                setPreset(option.seconds);
                setCustomText("");
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="field">
          <label className="label" htmlFor="grant-custom-seconds">
            Custom seconds
          </label>
          <input
            id="grant-custom-seconds"
            value={customText}
            onChange={(event) => setCustomText(event.target.value)}
            inputMode="numeric"
            placeholder="3600"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </fieldset>

      {outside.length > 0 ? (
        <p className="note note--err" role="alert">
          <IconAlert /> Outside the ceiling: {outside.join(", ")}.
        </p>
      ) : null}
      {emptySecretScope ? (
        <p className="note note--err" role="alert">
          <IconAlert /> Keep at least one action and one resource.
        </p>
      ) : null}
      {unresolvable ? (
        <p className="note note--err" role="alert">
          <IconAlert /> No Host connection matches this secret&apos;s reference.
        </p>
      ) : null}
      {customInvalid ? (
        <p className="note note--err" role="alert">
          <IconAlert /> Custom seconds must be a positive whole number.
        </p>
      ) : null}

      <div className="actions">
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={onBack}
        >
          ← Target
        </button>
        <button
          type="submit"
          className="btn btn--primary"
          disabled={
            blocked ||
            (connection !== null &&
              connection.connectionId !== "conn_local" &&
              !online)
          }
        >
          Continue
        </button>
      </div>
    </form>
  );
}
