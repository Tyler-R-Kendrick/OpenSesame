/**
 * Two selects: voice slug and inference slug. Agent Harnesses owns provider
 * setup; this only picks which connected (or built-in) slug each role uses.
 */

import {
  type ModelProviderRecord,
  withInference,
  withVoice,
} from "@opensesame/app-core/lib/model-provider.js";
import {
  type ModelSlugOption,
  choiceFromSlug,
  choiceToSlug,
} from "@opensesame/app-core/lib/model-slugs.js";
import { type ReactElement, useId } from "react";
import "./ai-model-roles.css";

export type ModelRoleSelectsProps = {
  readonly record: ModelProviderRecord;
  readonly busy: boolean;
  readonly voiceOptions: readonly ModelSlugOption[];
  readonly inferenceOptions: readonly ModelSlugOption[];
  readonly onCommit: (next: ModelProviderRecord) => void;
};

export function ModelRoleSelects(props: ModelRoleSelectsProps): ReactElement {
  const voiceId = useId();
  const inferenceId = useId();
  const voiceValue = props.voiceOptions.some(
    (option) => option.value === choiceToSlug(props.record.voice),
  )
    ? choiceToSlug(props.record.voice)
    : (props.voiceOptions[0]?.value ?? "");
  const inferenceValue = props.inferenceOptions.some(
    (option) => option.value === choiceToSlug(props.record.inference),
  )
    ? choiceToSlug(props.record.inference)
    : "";

  return (
    <div className="ai-roles">
      <label className="label" htmlFor={voiceId}>
        Voice
      </label>
      <select
        id={voiceId}
        aria-label="Voice model"
        disabled={props.busy || props.voiceOptions.length === 0}
        value={voiceValue}
        onChange={(event) => {
          const choice = choiceFromSlug(event.target.value, props.voiceOptions);
          if (choice) props.onCommit(withVoice(props.record, choice));
        }}
      >
        {props.voiceOptions.length === 0 ? (
          <option value="">Unavailable</option>
        ) : null}
        {props.voiceOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <label className="label" htmlFor={inferenceId}>
        Inference
      </label>
      <select
        id={inferenceId}
        aria-label="Inference model"
        disabled={props.busy}
        value={inferenceValue}
        onChange={(event) => {
          const choice = choiceFromSlug(
            event.target.value,
            props.inferenceOptions,
          );
          if (choice) props.onCommit(withInference(props.record, choice));
        }}
      >
        {props.inferenceOptions.map((option) => (
          <option key={option.value || "none"} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
