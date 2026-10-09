import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { errorText } from "@opensesame/app-core/sections/connections/shared.js";
import { type FormEvent, useId, useState } from "react";
import { Link } from "react-router";
import { FieldShell } from "../../../components/FieldShell.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { ConnectorIconField } from "./ConnectorIconField.js";
import { NativeConnectorFields } from "./NativeConnectorFields.js";
import { OutLink } from "./fields.js";
import {
  nativeEditTargetIds,
  nativeInitialMethod,
  nativeInitialValues,
} from "./native-connector-edit-values.js";
import {
  nativeError,
  nativeFieldValues,
  nativeMissingField,
  nativeNextValues,
  nativePublicUrl,
  nativeScopeDefaults,
  nativeVerified,
} from "./native-connector-ui-values.js";
import type {
  NativeConnectorCallbacks,
  NativeConnectorController,
  NativeConnectorDescriptor,
  NativeField,
  NativeMethodDescriptor,
} from "./native-connector-ui.js";
import { nativeDraftMethod } from "./native-provider-policy.js";

type Props = NativeConnectorCallbacks & {
  descriptor: NativeConnectorDescriptor;
  controller: NativeConnectorController;
  view?: NativeConnectorView | null;
};

function NativeMethodPicker({
  descriptor,
  method,
  locked,
  onMethod,
}: {
  descriptor: NativeConnectorDescriptor;
  method: string;
  locked: boolean;
  onMethod: (method: NativeMethodDescriptor) => void;
}) {
  const name = useId();
  return (
    <fieldset className="cx-block">
      <legend>Connection method</legend>
      <div
        className="cx-modes"
        role="radiogroup"
        aria-label="Connection method"
      >
        {descriptor.methods.map((choice) => (
          <label
            className="cx-mode"
            key={choice.id}
            title={choice.unavailableReason}
          >
            <input
              type="radio"
              name={name}
              checked={method === choice.id}
              disabled={locked || !choice.available}
              onChange={() => onMethod(choice)}
            />
            <span>{choice.label}</span>
          </label>
        ))}
      </div>
      {locked ? (
        <StatusMark
          tone="idle"
          label="This connection stays saved until removal completes. Remove it before choosing another method."
        />
      ) : null}
      {descriptor.methods
        .filter((choice) => !choice.available)
        .map((choice) => (
          <p className="hint" key={choice.id}>
            {choice.label}:{" "}
            {choice.unavailableReason ?? "Unavailable on this device."}
          </p>
        ))}
    </fieldset>
  );
}

function useNativeIcon(view?: NativeConnectorView | null) {
  const [icon, setIcon] = useState(view?.configuration.icon ?? "");
  const [iconBusy, setIconBusy] = useState(false);
  return { icon, setIcon, iconBusy, setIconBusy };
}

function useNativeForm({
  descriptor,
  controller,
  view,
  onChanged,
  onFlash,
}: Props) {
  const available = descriptor.methods.filter((item) => item.available);
  const initial = nativeInitialMethod(descriptor, view);
  const [methodId, setMethodId] = useState(initial?.id);
  const [name, setName] = useState(
    view?.configuration.displayName ?? descriptor.name,
  );
  const [values, setValues] = useState(() =>
    initial ? nativeInitialValues(initial, view) : {},
  );
  const [scopes, setScopes] = useState(() =>
    initial
      ? nativeScopeDefaults(initial, view?.configuration.requestedScopes)
      : {},
  );
  const [busy, setBusy] = useState(false);
  const image = useNativeIcon(view);
  const [failure, setFailure] = useState("");
  const selectedMethod = available.find((item) => item.id === methodId);
  const method = selectedMethod
    ? nativeDraftMethod(descriptor.providerId, selectedMethod, view, values)
    : undefined;

  function choose(next: NativeMethodDescriptor) {
    if (view || !next.available || busy || image.iconBusy) return;
    setMethodId(next.id);
    setValues(nativeInitialValues(next, view));
    setScopes(nativeScopeDefaults(next));
    setFailure("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      busy ||
      image.iconBusy ||
      !method ||
      !method.available ||
      nativeMissingField(method.fields, values) ||
      !name.trim()
    )
      return;
    setBusy(true);
    setFailure("");
    const credentials = nativeFieldValues(method.fields, values, true);
    try {
      const next = await controller.configure({
        method: method.id,
        displayName: name.trim(),
        icon: image.icon,
        parameters: nativeFieldValues(method.fields, values, false),
        credentials,
        requestedScopes: scopes,
        targetIds: nativeEditTargetIds(method, view),
      });
      if (next.providerId !== descriptor.providerId)
        throw new Error("Provider returned a different connection.");
      if (nativeVerified(next)) {
        setValues(nativeFieldValues(method.fields, values, false));
        onFlash({
          tone: "ok",
          text: `${descriptor.name} access verified and saved on this device.`,
        });
      } else {
        onFlash({
          tone: "warn",
          text: `${descriptor.name} authorization is incomplete.`,
        });
      }
    } catch (error) {
      const text = nativeError(errorText(error), credentials);
      setFailure(text);
      onFlash({ tone: "err", text });
    } finally {
      setBusy(false);
      onChanged(controller.load());
    }
  }
  return {
    method,
    name,
    setName,
    values,
    setValues,
    scopes,
    setScopes,
    busy,
    ...image,
    setFailure,
    failure,
    choose,
    submit,
  };
}

function NativeConfigurationLinks({
  descriptor,
}: { descriptor: NativeConnectorDescriptor }) {
  const docsUrl = descriptor.docsUrl
    ? nativePublicUrl(descriptor.docsUrl)
    : null;
  return (
    <>
      {docsUrl ? (
        <OutLink href={docsUrl}>{descriptor.name} documentation</OutLink>
      ) : null}
      {descriptor.configurationLinks?.map((link) => (
        <Link key={link.to} to={link.to}>
          {link.label}
        </Link>
      ))}
    </>
  );
}

function NativeFormStatus({
  method,
  missing,
  failure,
}: {
  method: NativeMethodDescriptor;
  missing: NativeField | undefined;
  failure: string;
}) {
  return (
    <>
      {missing ? (
        <StatusMark tone="warn" label={`${missing.label} is required.`} />
      ) : null}
      {failure ? <StatusMark tone="err" label={failure} /> : null}
      {!method.available ? (
        <StatusMark
          tone="warn"
          label={
            method.unavailableReason ??
            "This provider route is unavailable in this browser."
          }
        />
      ) : null}
    </>
  );
}

export function NativeConnectorForm(props: Props) {
  const model = useNativeForm(props);
  const { descriptor } = props;
  const missing = model.method
    ? nativeMissingField(model.method.fields, model.values)
    : undefined;
  return (
    <form
      className="cx-form panel__body"
      onSubmit={(event) => void model.submit(event)}
    >
      <fieldset
        className="cx-block cx-form"
        disabled={model.busy || model.iconBusy}
      >
        <legend className="visually-hidden">
          {descriptor.name} configuration
        </legend>
        <NativeMethodPicker
          descriptor={descriptor}
          method={props.view?.configuration.method ?? model.method?.id ?? ""}
          locked={!!props.view}
          onMethod={model.choose}
        />
        {model.method ? (
          <>
            <FieldShell
              label="Connector name"
              value={model.name}
              onValueChange={model.setName}
            />
            <ConnectorIconField
              value={model.icon}
              onChange={model.setIcon}
              onError={model.setFailure}
              onBusyChange={model.setIconBusy}
            />
            <NativeConnectorFields
              method={model.method}
              values={model.values}
              scopes={model.scopes}
              onValue={(id, value) =>
                model.setValues((current) =>
                  nativeNextValues(
                    model.method?.fields ?? [],
                    current,
                    id,
                    value,
                  ),
                )
              }
              onScopes={(actor, selected) =>
                model.setScopes((current) => ({
                  ...current,
                  [actor]: selected,
                }))
              }
            />
          </>
        ) : null}
      </fieldset>
      {model.method ? (
        <FormCommit
          label={`Verify and connect ${descriptor.name}`}
          busy={model.busy}
          disabled={
            model.busy ||
            model.iconBusy ||
            !model.method ||
            !model.method.available ||
            !!missing ||
            !model.name.trim()
          }
        >
          <NativeFormStatus
            method={model.method}
            missing={missing}
            failure={model.failure}
          />
        </FormCommit>
      ) : (
        <StatusMark
          tone="warn"
          label={`${descriptor.name} has no supported browser connection method.`}
        />
      )}
      <NativeConfigurationLinks descriptor={descriptor} />
    </form>
  );
}
