import {
  BUDGET_PRESETS,
  KEY_LIFETIMES,
} from "@opensesame/app-core/lib/model-keys/mint-form.js";
import type { Ref } from "react";
import { FieldShell } from "../../../../components/FieldShell.js";
import { StatusMark } from "../../../../components/StatusMark.js";
import type { MintKeyForm } from "./use-mint-key-form.js";

type Choice = Readonly<{ id: string; label: string }>;

type ChoicesProps = Readonly<{
  label: string;
  options: readonly Choice[];
  value: string;
  onPick: (id: string) => void;
}>;

function Choices({ label, options, value, onPick }: ChoicesProps) {
  return (
    <div className="mkey-choices" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className="mkey-choice"
          // biome-ignore lint/a11y/useSemanticElements: a pressed choice, not a form radio
          role="radio"
          aria-checked={value === option.id}
          onClick={() => onPick(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const LIFETIME_CHOICES: readonly Choice[] = KEY_LIFETIMES.map((entry) => ({
  id: String(entry.seconds),
  label: entry.label,
}));

type Props = Readonly<{
  form: MintKeyForm;
  /** The first field takes the focus when the sheet opens. */
  clientRef: Ref<HTMLInputElement>;
}>;

/** What the sheet asks before a key exists: who, which models, how much, how long. */
export function MintKeyFields({ form, clientRef }: Props) {
  const { client, models, name, list } = form;
  return (
    <>
      <FieldShell
        id="model-key-client"
        inputRef={clientRef}
        label="App or agent"
        autoComplete="off"
        placeholder="my-agent"
        value={client}
        disabled={form.busy}
        onValueChange={form.setClient}
        status={
          client !== "" && name === null ? (
            <StatusMark tone="err" label="Letters, digits and . _ : @ - only" />
          ) : null
        }
      />
      <FieldShell
        id="model-key-models"
        label="Models"
        mono
        autoComplete="off"
        placeholder="gpt-4o, gpt-4o-mini"
        value={models}
        disabled={form.busy}
        onValueChange={form.setModels}
        fills={[
          {
            label: "Any model",
            value: "*",
            onPick: () => form.setModels("*"),
          },
        ]}
        status={
          models !== "" && list === null ? (
            <StatusMark tone="err" label="Model ids, namespace/*, or *" />
          ) : null
        }
      />
      <Choices
        label="Budget"
        options={BUDGET_PRESETS}
        value={form.budgetId}
        onPick={form.setBudgetId}
      />
      <Choices
        label="Key lasts"
        options={LIFETIME_CHOICES}
        value={String(form.seconds)}
        onPick={(id) => form.setSeconds(Number(id))}
      />
    </>
  );
}
