import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { errorText } from "@opensesame/app-core/sections/connections/shared.js";
import { type FormEvent, useEffect, useState } from "react";
import { FormCommit } from "../../../components/FormCommit.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { NativeInputFields } from "./NativeConnectorFields.js";
import { NativeMcpArgumentGuide } from "./NativeMcpArgumentGuide.js";
import { NativeSecretResult } from "./NativeSecretResult.js";
import {
  nativeDefaults,
  nativeError,
  nativeFieldValues,
  nativeMissingField,
  nativeNextValues,
  nativePublicUrl,
  nativeVerified,
  nativeVisibleFields,
} from "./native-connector-ui-values.js";
import type {
  NativeActionDescriptor,
  NativeConnectorCallbacks,
  NativeConnectorController,
  NativeConnectorDescriptor,
  SafeActionResult,
} from "./native-connector-ui.js";

function NativeActionResults({
  result,
  origins,
}: { result: SafeActionResult; origins: readonly string[] }) {
  return (
    <section aria-label={result.label}>
      <output>{result.label}</output>
      {result.items.length ? (
        <ul>
          {result.items.map((item) => {
            const url = item.url ? nativePublicUrl(item.url, origins) : null;
            return (
              <li key={item.id}>
                {item.secretValue !== undefined ? (
                  <NativeSecretResult
                    label={item.label}
                    value={item.secretValue}
                  />
                ) : url ? (
                  <a href={url} target="_blank" rel="noreferrer noopener">
                    {item.label}
                  </a>
                ) : (
                  item.label
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

type ActionProps = NativeConnectorCallbacks & {
  action: NativeActionDescriptor;
  controller: NativeConnectorController;
  connected: boolean;
  disabled: boolean;
};

function clearedActionSecrets(
  action: NativeActionDescriptor,
  values: Record<string, string>,
) {
  return {
    ...values,
    ...Object.fromEntries(
      action.fields
        .filter((field) => field.secret)
        .map((field) => [field.id, ""]),
    ),
  };
}

function NativeAction({
  action,
  controller,
  connected,
  disabled,
  onChanged,
  onFlash,
}: ActionProps) {
  const [values, setValues] = useState(() => nativeDefaults(action.fields));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [result, setResult] = useState<SafeActionResult | null>(null);
  const [readRevision, setReadRevision] = useState(0);
  const enabled = connected && action.available && !disabled;
  const missing = nativeMissingField(action.fields, values);
  useEffect(() => {
    if (!enabled) setResult(null);
  }, [enabled]);

  async function run(event: FormEvent) {
    event.preventDefault();
    if (!enabled || busy || missing) return;
    setBusy(true);
    setFailure("");
    setResult(null);
    setReadRevision((revision) => revision + 1);
    try {
      const found = await controller.invoke(
        action.id,
        Object.fromEntries(
          nativeVisibleFields(action.fields, values).map((field) => [
            field.id,
            values[field.id] ?? "",
          ]),
        ),
      );
      setResult(found);
      setValues((current) => clearedActionSecrets(action, current));
    } catch (error) {
      const text = nativeError(
        errorText(error),
        nativeFieldValues(action.fields, values, true),
      );
      setFailure(text);
      onFlash({ tone: "err", text });
    } finally {
      setBusy(false);
      onChanged(controller.load());
    }
  }
  return (
    <details className="cx-application">
      <summary>{action.label}</summary>
      <form className="cx-form" onSubmit={(event) => void run(event)}>
        <fieldset className="cx-block cx-form" disabled={busy || !enabled}>
          <legend className="visually-hidden">{action.label}</legend>
          {action.inputSchema ? (
            <NativeMcpArgumentGuide schema={action.inputSchema} />
          ) : null}
          <NativeInputFields
            fields={action.fields}
            values={values}
            onChange={(id, value) =>
              setValues((current) =>
                nativeNextValues(action.fields, current, id, value),
              )
            }
          />
          <FormCommit
            label={action.label}
            busy={busy}
            disabled={busy || !enabled || !!missing}
          >
            {!action.available ? (
              <StatusMark
                tone="warn"
                label={
                  action.reason ??
                  "This action is unavailable for this connection."
                }
              />
            ) : null}
            {failure ? <StatusMark tone="err" label={failure} /> : null}
          </FormCommit>
        </fieldset>
        {enabled && result ? (
          <NativeActionResults
            key={readRevision}
            result={result}
            origins={action.resultOrigins}
          />
        ) : null}
      </form>
    </details>
  );
}

export function NativeConnectorActions({
  descriptor,
  controller,
  view,
  disabled = false,
  onChanged,
  onFlash,
}: NativeConnectorCallbacks & {
  descriptor: NativeConnectorDescriptor;
  controller: NativeConnectorController;
  view: NativeConnectorView;
  disabled?: boolean;
}) {
  if (descriptor.actions.length === 0) return null;
  return (
    <section className="cx-block cx-form" aria-label={`Use ${descriptor.name}`}>
      <h3>Use {descriptor.name}</h3>
      {descriptor.actions.map((action) => (
        <NativeAction
          key={`${view.fingerprint}/${action.id}`}
          action={action}
          controller={controller}
          connected={nativeVerified(view)}
          disabled={disabled}
          onChanged={onChanged}
          onFlash={onFlash}
        />
      ))}
    </section>
  );
}
