/**
 * State and actions for the Create-a-key sheet (ADR 0190 §6): who the key is
 * for, which models, how much, for how long, and the one call that mints it.
 * Reading what was typed is the app-core helpers' job (`parseClientName`,
 * `parseModelList`), so the sheet only holds the draft; what comes of making a
 * key is `useMintFlight`'s.
 */
import {
  BUDGET_PRESETS,
  KEY_LIFETIMES,
  parseClientName,
  parseModelList,
} from "@opensesame/app-core/lib/model-keys/mint-form.js";
import {
  type MintChoice,
  confirmMint,
  mintModelKey,
} from "@opensesame/app-core/lib/model-keys/mint.js";
import { type FormEvent, useState } from "react";
import { useVault } from "../../../../lib/vault/hooks.js";
import { useMintFlight } from "./use-mint-flight.js";

type Options = Readonly<{
  connectionId: string;
  /** The provider's base URL: the resource every key is for. */
  resource: string;
  onClose: () => void;
}>;

const FIRST_BUDGET = BUDGET_PRESETS[0]?.id ?? "";
const FIRST_LIFETIME = KEY_LIFETIMES[0]?.seconds ?? 0;

export function useMintKeyForm({ connectionId, resource, onClose }: Options) {
  const { tomb } = useVault();
  const [client, setClient] = useState("");
  const [models, setModels] = useState("");
  const [budgetId, setBudgetId] = useState<string>(FIRST_BUDGET);
  const [seconds, setSeconds] = useState<number>(FIRST_LIFETIME);
  const { busy, failure, issued, start, close, done } = useMintFlight(onClose);

  const name = parseClientName(client);
  const list = parseModelList(models);
  const preset = BUDGET_PRESETS.find((entry) => entry.id === budgetId);
  const lifetime = KEY_LIFETIMES.find((entry) => entry.seconds === seconds);
  const draft =
    name !== null && list !== null && preset ? { name, list, preset } : null;
  const ready = draft !== null && !busy;

  const create = () => {
    if (!draft) return;
    // The press, and the draft as the sheet shows it at that moment, are what the person approves.
    const pressedAt = Date.now();
    const choice: MintChoice = {
      clientId: draft.name,
      connectionId,
      resource,
      actions: ["model.invoke", "model.list"],
      models: draft.list,
      budget: draft.preset.budget,
      lifetimeSeconds: seconds,
    };
    start(async () =>
      mintModelKey(tomb, choice, await confirmMint(tomb, choice, pressedAt)),
    );
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (issued) done();
    else create();
  };

  return {
    client,
    models,
    budgetId,
    seconds,
    busy,
    failure,
    issued,
    name,
    list,
    preset,
    lifetime,
    ready,
    setClient,
    setModels,
    setBudgetId,
    setSeconds,
    create,
    close,
    done,
    submit,
  };
}

export type MintKeyForm = ReturnType<typeof useMintKeyForm>;
