/**
 * Create a key for an app or an agent (ADR 0192 §6): who it is for, which
 * models, how much, for how long. The person's unlocked vault approves exactly
 * what the sheet shows, the key is shown once, and closing the sheet forgets
 * it — only its digest stays in the broker.
 */
import type { BudgetPreset } from "@opensesame/app-core/lib/model-keys/mint-form.js";
import { useRef } from "react";
import { CeremonySheet } from "../../../../components/CeremonySheet.js";
import { CeremonyShell } from "../../../../components/CeremonyShell.js";
import { FailureNotice } from "../../../../components/FailureNotice.js";
import { IconPlus } from "../../../../components/Icons.js";
import { StatusMark } from "../../../../components/StatusMark.js";
import { IssuedKey } from "./IssuedKey.js";
import { MintKeyFields } from "./MintKeyFields.js";
import { type MintKeyForm, useMintKeyForm } from "./use-mint-key-form.js";

type Props = Readonly<{
  providerName: string;
  connectionId: string;
  /** The provider's base URL: the resource every key is for. */
  resource: string;
  onClose: () => void;
}>;

function sheetFacts(providerName: string, preset: BudgetPreset | undefined) {
  return [
    { key: "Spends", value: `${providerName}'s saved key` },
    ...(preset
      ? [{ key: "Budget", value: `${preset.budget.requests} requests` }]
      : []),
  ];
}

function sheetPrimary(form: MintKeyForm) {
  return form.issued
    ? { label: "Done", submit: true, onClick: form.done }
    : {
        label: "Create a key",
        submit: true,
        busy: form.busy,
        disabled: !form.ready,
        onClick: form.create,
      };
}

export function MintKeySheet({
  providerName,
  connectionId,
  resource,
  onClose,
}: Props) {
  const form = useMintKeyForm({ connectionId, resource, onClose });
  const clientRef = useRef<HTMLInputElement>(null);
  const { issued, failure } = form;

  return (
    <CeremonySheet
      title="Create a key"
      mark={<IconPlus size={20} />}
      onClose={form.close}
      initialFocus={clientRef}
    >
      <form aria-label="Create a key" onSubmit={form.submit}>
        {/* Create and Done are different keys, not one key relabelled: the press
            that made the key is still on the old one, and must not land on Done. */}
        <CeremonyShell
          key={issued ? "issued" : "compose"}
          ok={failure === ""}
          top={issued ? "Key created" : undefined}
          name={issued ? (form.name ?? "") : providerName}
          facts={sheetFacts(providerName, form.preset)}
          primary={sheetPrimary(form)}
        >
          {issued ? (
            <IssuedKey
              issued={issued}
              lifetime={form.lifetime?.label ?? "its lifetime"}
            />
          ) : (
            <MintKeyFields form={form} clientRef={clientRef} />
          )}
          {failure ? (
            <p className="vexport__marks">
              <StatusMark tone="err" label={failure} />
            </p>
          ) : null}
          <FailureNotice id="model-keys:mint" title="Keys" message={failure} />
        </CeremonyShell>
      </form>
    </CeremonySheet>
  );
}
