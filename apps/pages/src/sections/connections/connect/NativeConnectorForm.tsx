import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { errorText } from "@opensesame/app-core/sections/connections/shared.js";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { FormCommit } from "../../../components/FormCommit.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { NativeCancelSignIn } from "./NativeCancelSignIn.js";
import { NativeConnectorFields } from "./NativeConnectorFields.js";
import {
  NativeConnectorFormOptions,
  NativeMethodPicker,
  nativeFormLabel,
  nativeSignInRequired,
} from "./NativeConnectorFormOptions.js";
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

function useNativePreferences(
  defaultName: string,
  view?: NativeConnectorView | null,
) {
  const [name, setName] = useState(
    view?.configuration.displayName ?? defaultName,
  );
  const [icon, setIcon] = useState(view?.configuration.icon ?? "");
  const [iconBusy, setIconBusy] = useState(false);
  return { name, setName, icon, setIcon, iconBusy, setIconBusy };
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
  const [values, setValues] = useState(() =>
    initial ? nativeInitialValues(initial, view) : {},
  );
  const [scopes, setScopes] = useState(() =>
    initial
      ? nativeScopeDefaults(initial, view?.configuration.requestedScopes)
      : {},
  );
  const [busy, setBusy] = useState(false);
  const image = useNativePreferences(descriptor.name, view);
  const { name } = image;
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
      const signIn = nativeSignInRequired(method, view);
      const next = await (signIn ? controller.connect : controller.configure)({
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
          text: `Complete ${descriptor.name} sign-in to connect.`,
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
            {props.view && nativeVerified(props.view) ? (
              <NativeConnectorFormOptions
                name={model.name}
                onName={model.setName}
                icon={model.icon}
                onIcon={model.setIcon}
                onError={model.setFailure}
                onBusy={model.setIconBusy}
              />
            ) : null}
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
          label={nativeFormLabel(model.method, props.view, descriptor.name)}
          busy={model.busy}
          disabled={
            model.busy ||
            model.iconBusy ||
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
      <NativeCancelSignIn
        busy={model.busy}
        method={model.method}
        view={props.view}
        onCancel={props.controller.cancelAuthorization}
      />
      <NativeConfigurationLinks descriptor={descriptor} />
    </form>
  );
}
