import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { useId } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import { ConnectorIconField } from "./ConnectorIconField.js";
import { nativeVerified } from "./native-connector-ui-values.js";
import type {
  NativeConnectorDescriptor,
  NativeMethodDescriptor,
} from "./native-connector-ui.js";

export function nativeSignInRequired(
  method: NativeMethodDescriptor,
  view?: NativeConnectorView | null,
): boolean {
  const authorizes =
    method.authorizeFirst ?? ["oauth", "mcp", "oidc"].includes(method.id);
  return authorizes && !(view && nativeVerified(view));
}

export function nativeFormLabel(
  method: NativeMethodDescriptor,
  view: NativeConnectorView | null | undefined,
  name: string,
): string {
  return nativeSignInRequired(method, view)
    ? `Sign in to ${name}`
    : `Verify and connect ${name}`;
}

/** Authentication choices precede metadata; unavailable protocols stay in help. */
export function NativeMethodPicker({
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
  const choices = descriptor.methods.filter((choice) => choice.available);
  const unavailable = descriptor.methods.filter((choice) => !choice.available);
  return (
    <>
      {choices.length > 1 ? (
        <fieldset className="cx-block">
          <legend>Sign-in method</legend>
          <div
            className="cx-modes"
            role="radiogroup"
            aria-label="Sign-in method"
          >
            {choices.map((choice) => (
              <label className="cx-mode" key={choice.id}>
                <input
                  type="radio"
                  name={name}
                  checked={method === choice.id}
                  disabled={locked}
                  onChange={() => onMethod(choice)}
                />
                <span>{choice.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {unavailable.length ? (
        <details className="cx-application">
          <summary>Other sign-in methods</summary>
          {unavailable.map((choice) => (
            <p className="hint" key={choice.id}>
              {choice.label}:{" "}
              {choice.unavailableReason ?? "Unavailable on this device."}
            </p>
          ))}
        </details>
      ) : null}
    </>
  );
}

/** Cosmetic preferences are offered only after the provider has verified access. */
export function NativeConnectorFormOptions({
  name,
  onName,
  icon,
  onIcon,
  onError,
  onBusy,
}: {
  name: string;
  onName: (value: string) => void;
  icon: string;
  onIcon: (value: string) => void;
  onError: (value: string) => void;
  onBusy: (value: boolean) => void;
}) {
  return (
    <details className="cx-application">
      <summary>Appearance</summary>
      <FieldShell label="Connector name" value={name} onValueChange={onName} />
      <ConnectorIconField
        value={icon}
        onChange={onIcon}
        onError={onError}
        onBusyChange={onBusy}
      />
    </details>
  );
}
