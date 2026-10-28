import {
  UNAVAILABLE_LABEL,
  leadingUnavailableKind,
} from "@opensesame/app-core/lib/browser-disposition.js";
import { docLink } from "@opensesame/app-core/lib/doc-link.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { errorText } from "@opensesame/app-core/sections/connections/shared.js";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { FormCommit } from "../../../components/FormCommit.js";
import { StatusMark } from "../../../components/StatusMark.js";
import {
  NativeCancelSignIn,
  nativeConfigurationOwner,
  useNativeSignInUiLifetime,
} from "./NativeCancelSignIn.js";
import { NativeConnectorFields } from "./NativeConnectorFields.js";
import {
  NativeConnectorFormOptions,
  NativeMethodPicker,
  nativeFormLabel,
  nativeSignInRequired,
} from "./NativeConnectorFormOptions.js";
import { OutLink } from "./fields.js";
import type { NativeAuthorizationTicket } from "./native-connector-controller.js";
import {
  nativeEditTargetIds,
  useNativeMethodSelection,
} from "./native-connector-edit-values.js";
import {
  nativeError,
  nativeFieldValues,
  nativeMissingField,
  nativeNextValues,
  nativePublicUrl,
  nativeScopeDefaults,
  nativeVerificationClaim,
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
  authorization?: NativeAuthorizationTicket | null;
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

function useNativeFormFeedback(props: Props) {
  const { authorization } = props;
  const lifetime = useNativeSignInUiLifetime(props);
  const [busyOwner, setBusyOwner] = useState<object | null>(null);
  const busy = busyOwner === lifetime.owner || !!authorization?.current();
  const [failureState, setFailureState] = useState<{
    owner: object;
    text: string;
  } | null>(null);
  const failure =
    failureState?.owner === lifetime.owner ? failureState.text : "";
  const setFailure = (text: string) =>
    setFailureState({ owner: lifetime.owner, text });
  return { lifetime, busy, setBusyOwner, failure, setFailure };
}

function nativeFormReady(
  method: NativeMethodDescriptor | undefined,
  values: Record<string, string>,
  busy: boolean,
  iconBusy: boolean,
  name: string,
) {
  return (
    !busy &&
    !iconBusy &&
    method?.available &&
    !nativeMissingField(method.fields, values) &&
    !!name.trim()
  );
}

function useNativeForm(props: Props) {
  const { descriptor, controller, view, onChanged, onFlash } = props;
  const { lifetime, busy, setBusyOwner, failure, setFailure } =
    useNativeFormFeedback(props);
  const image = useNativePreferences(descriptor.name, view);
  const { name } = image;
  const { values, setValues, scopes, setScopes, choose, selectedMethod } =
    useNativeMethodSelection(
      descriptor,
      view,
      busy,
      image.iconBusy,
      setFailure,
    );
  const providerId = descriptor.providerId;
  const method = selectedMethod
    ? nativeDraftMethod(providerId, selectedMethod, view, values, scopes)
    : undefined;

  const ready = nativeFormReady(method, values, busy, image.iconBusy, name);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!method || !ready) return;
    const attempt = lifetime.begin();
    if (!attempt.current()) return;
    setBusyOwner(lifetime.owner);
    setFailure("");
    const credentials = nativeFieldValues(method.fields, values, true);
    try {
      const signIn = nativeSignInRequired(method, view);
      const next = await (signIn ? controller.connect : controller.configure)({
        method: method.id,
        owner: nativeConfigurationOwner(attempt),
        displayName: name.trim(),
        icon: image.icon,
        parameters: nativeFieldValues(method.fields, values, false),
        credentials,
        requestedScopes: nativeScopeDefaults(method, scopes),
        targetIds: nativeEditTargetIds(method, view),
      });
      if (!attempt.current()) return;
      if (next.providerId !== descriptor.providerId)
        throw new Error("Provider returned a different connection.");
      if (nativeVerified(next)) {
        setValues(nativeFieldValues(method.fields, values, false));
        onFlash({
          tone: "ok",
          text:
            method.id === "native-local"
              ? `${descriptor.name} configuration verified and saved on this device; provider access was not checked.`
              : nativeVerificationClaim(
                  descriptor.providerId,
                  descriptor.name,
                  true,
                ),
        });
      } else {
        onFlash({
          tone: "warn",
          text: `Complete ${descriptor.name} sign-in to connect.`,
        });
      }
    } catch (error) {
      if (attempt.current()) {
        const text = nativeError(errorText(error), credentials);
        setFailure(text);
        onFlash({ tone: "err", text });
      }
    } finally {
      try {
        if (attempt.current()) {
          setBusyOwner(null);
          const next = controller.load();
          if (attempt.current()) onChanged(next);
        }
      } finally {
        attempt.finish();
      }
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
  const docs = docLink(descriptor.name, docsUrl);
  return (
    <>
      {docs ? <OutLink href={docs.url}>{docs.label}</OutLink> : null}
      {descriptor.externalLinks?.map((link) => (
        <OutLink key={link.url} href={link.url}>
          {link.label}
        </OutLink>
      ))}
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

/** Nothing here can connect: say why in the reason's own words, not a generic one. */
function NoMethodStatus({
  descriptor,
}: { descriptor: NativeConnectorDescriptor }) {
  const kinds = descriptor.methods.map((method) => method.unavailableKind);
  const kind = leadingUnavailableKind(kinds);
  return kinds.some((entry) => entry !== undefined) ? (
    <StatusMark
      tone={kind === "built-in" ? "ok" : "warn"}
      label={`${descriptor.name}: ${UNAVAILABLE_LABEL[kind]}`}
    />
  ) : (
    <StatusMark
      tone="warn"
      label={`${descriptor.name} has no supported browser connection method.`}
    />
  );
}

function NativeFormCommit({
  props,
  model,
  missing,
}: {
  props: Props;
  model: ReturnType<typeof useNativeForm>;
  missing: NativeField | undefined;
}) {
  const { descriptor } = props;
  return model.method || props.authorization?.current() ? (
    <FormCommit
      label={
        model.method
          ? nativeFormLabel(model.method, props.view, descriptor.name)
          : `Sign in to ${descriptor.name}`
      }
      busy={model.busy}
      disabled={
        model.busy ||
        model.iconBusy ||
        !model.method?.available ||
        !!missing ||
        !model.name.trim()
      }
    >
      {model.method ? (
        <NativeFormStatus
          method={model.method}
          missing={missing}
          failure={model.failure}
        />
      ) : (
        <NoMethodStatus descriptor={descriptor} />
      )}
      <NativeCancelSignIn
        busy={model.busy}
        method={model.method}
        view={props.view}
        onCancel={props.controller.cancelAuthorization}
        authorization={props.authorization}
      />
    </FormCommit>
  ) : (
    <NoMethodStatus descriptor={descriptor} />
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
      <NativeFormCommit props={props} model={model} missing={missing} />
      <NativeConfigurationLinks descriptor={descriptor} />
    </form>
  );
}
