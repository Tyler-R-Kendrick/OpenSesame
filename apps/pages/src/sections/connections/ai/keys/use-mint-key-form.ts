/**
 * State and actions for the Create-a-key sheet (ADR 0189 §6): who the key is
 * for, which models, how much, for how long, and the one call that mints it.
 * Reading what was typed is the app-core helpers' job (`parseClientName`,
 * `parseModelList`), so the sheet only holds the draft and what came of it.
 */
import type { IssuedRoot } from "@opensesame/app-core/lib/model-keys/broker.js";
import { describeMintFailure } from "@opensesame/app-core/lib/model-keys/mint-failure.js";
import {
  BUDGET_PRESETS,
  KEY_LIFETIMES,
  parseClientName,
  parseModelList,
} from "@opensesame/app-core/lib/model-keys/mint-form.js";
import { mintModelKey } from "@opensesame/app-core/lib/model-keys/mint.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import { type FormEvent, useState } from "react";
import { useVault } from "../../../../lib/vault/hooks.js";

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
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [issued, setIssued] = useState<IssuedRoot | null>(null);

  const name = parseClientName(client);
  const list = parseModelList(models);
  const preset = BUDGET_PRESETS.find((entry) => entry.id === budgetId);
  const lifetime = KEY_LIFETIMES.find((entry) => entry.seconds === seconds);
  const draft =
    name !== null && list !== null && preset ? { name, list, preset } : null;
  const ready = draft !== null && !busy;

  const create = () => {
    if (!draft || busy) return;
    setBusy(true);
    setFailure("");
    mintModelKey(tomb, {
      clientId: draft.name,
      connectionId,
      resource,
      actions: ["model.invoke", "model.list"],
      models: draft.list,
      budget: draft.preset.budget,
      lifetimeSeconds: seconds,
    })
      .then(setIssued)
      .catch((error: BoundaryValue) => setFailure(describeMintFailure(error)))
      .finally(() => setBusy(false));
  };

  const close = () => {
    // The key was never kept; dropping the state is forgetting it.
    setIssued(null);
    onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (issued) close();
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
    submit,
  };
}

export type MintKeyForm = ReturnType<typeof useMintKeyForm>;
