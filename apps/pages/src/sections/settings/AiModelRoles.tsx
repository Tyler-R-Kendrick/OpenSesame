import { IconCheck } from "../../components/Icons.js";
/**
 * Shared voice + inference catalog pickers for Setup › AI and Settings › AI models.
 */

import { StatusMark } from "../../components/StatusMark.js";
import type { ModelCatalogEntry } from "../../lib/model-catalog.js";
import {
  INFERENCE_MODEL_CATALOG,
  VOICE_MODEL_CATALOG,
} from "../../lib/model-catalog.js";
import {
  type AiModelChoice,
  type ModelProviderRecord,
  NO_INFERENCE_CHOICE,
  NO_MODEL_PROVIDER,
  withInference,
  withVoice,
} from "../../lib/model-provider.js";
import "./ai-model-roles.css";

export function choiceFromEntry(
  entry: ModelCatalogEntry,
  modelOverride?: string,
): AiModelChoice {
  return {
    kind: entry.kind,
    provider: entry.id,
    endpoint: entry.endpoint,
    model: modelOverride ?? entry.model,
  };
}

type RoleListProps = {
  readonly record: ModelProviderRecord;
  readonly busy: boolean;
  readonly onCommit: (next: ModelProviderRecord) => void;
  /** Setup uses card chrome; Settings uses the denser list. */
  readonly chrome: "cards" | "list";
};

type VoiceRoleProps = RoleListProps & {
  /** When false, withhold the catalog rather than greying it. */
  readonly speechReady?: boolean;
};

function VoiceLangSelect(props: {
  readonly voice: AiModelChoice;
  readonly entry: ModelCatalogEntry;
  readonly busy: boolean;
  readonly record: ModelProviderRecord;
  readonly onCommit: (next: ModelProviderRecord) => void;
}) {
  const { voice, entry, busy, record, onCommit } = props;
  if (entry.models.length === 0) return null;
  return (
    <label className="field">
      <span>Speech language</span>
      <select
        value={voice.model || entry.model}
        disabled={busy}
        onChange={(event) =>
          onCommit(
            withVoice(record, choiceFromEntry(entry, event.target.value)),
          )
        }
      >
        {entry.models.map((lang) => (
          <option key={lang} value={lang}>
            {lang}
          </option>
        ))}
      </select>
    </label>
  );
}

function VoiceCards(props: RoleListProps) {
  const { record, busy, onCommit } = props;
  return (
    <ul className="xcards" aria-label="Voice models">
      {VOICE_MODEL_CATALOG.map((entry) => {
        const inUse = record.voice.provider === entry.id;
        return (
          <li key={entry.id} className={`xcard${inUse ? " is-on" : ""}`}>
            <button
              type="button"
              className="xcard__pick"
              aria-pressed={inUse}
              disabled={busy}
              onClick={() =>
                onCommit(
                  withVoice(
                    record,
                    choiceFromEntry(entry, record.voice.model || entry.model),
                  ),
                )
              }
            >
              <span className="xcard__name">{entry.name}</span>
              <span className="xcard__kind">{entry.kindLabel}</span>
            </button>
            <span className="xcard__side">
              {inUse ? (
                <StatusMark tone="ok" label="In use" />
              ) : (
                <span>Device</span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function VoiceList(props: RoleListProps) {
  const { record, busy, onCommit } = props;
  return (
    <ul className="list" aria-label="Voice models">
      {VOICE_MODEL_CATALOG.map((entry) => (
        <li key={entry.id}>
          <div>
            <strong>{entry.name}</strong>
            <div className="ai-role__kind">{entry.kindLabel}</div>
          </div>
          <button
            type="button"
            className="icon-btn"
            disabled={busy}
            aria-label={
              record.voice.provider === entry.id
                ? `Using ${entry.name}`
                : `Use ${entry.name}`
            }
            title={entry.name}
            onClick={() =>
              onCommit(
                withVoice(
                  record,
                  choiceFromEntry(entry, record.voice.model || entry.model),
                ),
              )
            }
          >
            <IconCheck size={16} />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function VoiceRolePicker(props: VoiceRoleProps) {
  const entry =
    VOICE_MODEL_CATALOG.find((row) => row.id === props.record.voice.provider) ??
    VOICE_MODEL_CATALOG[0];
  if (props.speechReady === false) {
    return (
      <>
        <h3 className="ai-role__title">
          Voice
          <StatusMark
            tone="idle"
            label="This browser has no speech recognition, so the mic stays off. Typed commands still work."
          />
        </h3>
      </>
    );
  }
  return (
    <>
      <h3 className="ai-role__title">Voice</h3>
      {props.chrome === "cards" ? (
        <VoiceCards {...props} />
      ) : (
        <VoiceList {...props} />
      )}
      {entry ? (
        <VoiceLangSelect
          voice={props.record.voice}
          entry={entry}
          busy={props.busy}
          record={props.record}
          onCommit={props.onCommit}
        />
      ) : null}
    </>
  );
}

type InferenceRefineProps = {
  readonly record: ModelProviderRecord;
  readonly busy: boolean;
  readonly endpoint: string;
  readonly model: string;
  readonly setEndpoint: (value: string) => void;
  readonly setModel: (value: string) => void;
  readonly onCommit: (next: ModelProviderRecord) => void;
  readonly onClear?: () => void;
  /** Settings saves on an explicit button; setup commits on blur. */
  readonly mode: "blur" | "button";
};

export function InferenceRefineFields(props: InferenceRefineProps) {
  const refine =
    props.record.inference.kind === "local" ||
    props.record.inference.kind === "hosted";
  if (!refine) return null;

  const commitRefine = () =>
    props.onCommit(
      withInference(props.record, {
        ...props.record.inference,
        endpoint: props.endpoint,
        model: props.model,
      }),
    );

  return (
    <>
      <label className="field">
        <span>Endpoint</span>
        <input
          type="url"
          value={props.endpoint}
          onChange={(event) => props.setEndpoint(event.target.value)}
          onBlur={props.mode === "blur" ? commitRefine : undefined}
          placeholder="http://127.0.0.1:11434"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <label className="field">
        <span>Model</span>
        <input
          type="text"
          value={props.model}
          onChange={(event) => props.setModel(event.target.value)}
          onBlur={props.mode === "blur" ? commitRefine : undefined}
          placeholder="a vision model — it has to see the page"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      {props.mode === "button" ? (
        <div className="actions">
          <button
            type="button"
            className="icon-btn"
            disabled={props.busy}
            onClick={commitRefine}
            aria-label="Save"
            title="Save"
          >
            <IconCheck size={16} />
          </button>
          {props.onClear ? (
            <button
              type="button"
              className="icon-btn"
              disabled={props.busy}
              aria-label="Use no provider"
              title="Use no provider"
              onClick={props.onClear}
            >
              <IconCheck size={16} />
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

type InferenceListProps = RoleListProps & {
  readonly browserReady: boolean;
};

function InferenceCards(props: InferenceListProps) {
  const { record, busy, onCommit, browserReady } = props;
  return (
    <ul className="xcards" aria-label="Inference models">
      {browserReady ? (
        <li
          className={`xcard${record.inference.provider === "browser" ? " is-on" : ""}`}
        >
          <button
            type="button"
            className="xcard__pick"
            aria-pressed={record.inference.provider === "browser"}
            disabled={busy}
            onClick={() =>
              onCommit(
                withInference(record, {
                  kind: "browser",
                  provider: "browser",
                  endpoint: "",
                  model: "",
                }),
              )
            }
          >
            <span className="xcard__name">This device&apos;s own model</span>
            <span className="xcard__kind">in the browser</span>
          </button>
          <span className="xcard__side">
            {record.inference.provider === "browser" ? (
              <StatusMark tone="ok" label="In use" />
            ) : (
              <span>Device</span>
            )}
          </span>
        </li>
      ) : null}
      {INFERENCE_MODEL_CATALOG.map((entry) => {
        const inUse = record.inference.provider === entry.id;
        return (
          <li key={entry.id} className={`xcard${inUse ? " is-on" : ""}`}>
            <button
              type="button"
              className="xcard__pick"
              aria-pressed={inUse}
              disabled={busy}
              onClick={() =>
                onCommit(withInference(record, choiceFromEntry(entry)))
              }
            >
              <span className="xcard__name">{entry.name}</span>
              <span className="xcard__kind">{entry.kindLabel}</span>
            </button>
            <span className="xcard__side">
              {inUse ? (
                <StatusMark tone="ok" label="In use" />
              ) : (
                <span>{entry.kind === "local" ? "Local" : "Hosted"}</span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function InferenceListRows(props: InferenceListProps) {
  const { record, busy, onCommit } = props;
  return (
    <ul className="list" aria-label="Inference models">
      {INFERENCE_MODEL_CATALOG.map((entry) => (
        <li key={entry.id}>
          <div>
            <strong>{entry.name}</strong>
            <div className="ai-role__kind">{entry.kindLabel}</div>
          </div>
          <button
            type="button"
            className="icon-btn"
            disabled={busy}
            aria-label={
              record.inference.provider === entry.id
                ? `Using ${entry.name}`
                : `Use ${entry.name}`
            }
            title={entry.name}
            onClick={() =>
              onCommit(withInference(record, choiceFromEntry(entry)))
            }
          >
            <IconCheck size={16} />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function InferenceRolePicker(props: InferenceListProps) {
  return (
    <>
      <h3 className="ai-role__title">Inference</h3>
      {props.chrome === "cards" ? (
        <InferenceCards {...props} />
      ) : (
        <InferenceListRows {...props} />
      )}
    </>
  );
}

export function clearInference(
  record: ModelProviderRecord,
): ModelProviderRecord {
  return withInference(record, NO_INFERENCE_CHOICE);
}

export function emptyAiRecord(): ModelProviderRecord {
  return NO_MODEL_PROVIDER;
}
