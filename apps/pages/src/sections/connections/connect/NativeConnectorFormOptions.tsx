import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { ConnectorIconField } from "./ConnectorIconField.js";
import { ConnectorModes } from "./ConnectorModes.js";
import { OutLink } from "./fields.js";
import {
  nativePublicUrl,
  nativeVerified,
} from "./native-connector-ui-values.js";
import { nativeMethodConfigurable } from "./native-connector-ui.js";
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
  if (method.id === "native-local")
    return `Verify and save ${name} configuration`;
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
  const choices = descriptor.methods
    .filter(nativeMethodConfigurable)
    .sort(
      (left, right) =>
        (left.preferredRank ?? Number.MAX_SAFE_INTEGER) -
        (right.preferredRank ?? Number.MAX_SAFE_INTEGER),
    );
  const unavailable = descriptor.methods.filter(
    (choice) => !nativeMethodConfigurable(choice),
  );
  return (
    <>
      {choices.length > 1 ? (
        <ConnectorModes
          label="Sign-in method"
          value={
            // SAFETY: ConnectorModes only compares the value with each option's id, so a method that matches none checks none.
            method as NativeMethodDescriptor["id"]
          }
          options={choices.map((choice) => ({
            id: choice.id,
            label: choice.label,
          }))}
          disabled={locked}
          onChange={(id) => {
            const next = choices.find((choice) => choice.id === id);
            if (next) onMethod(next);
          }}
        />
      ) : null}
      {unavailable.length ? (
        // With nothing to connect, the reasons are the page: open by default.
        <details className="cx-application" open={choices.length === 0}>
          <summary>
            {choices.length ? "Other sign-in methods" : "Why not"}
          </summary>
          {unavailable.map((choice) => (
            <div key={choice.id}>
              <p className="hint">
                {choice.label}:{" "}
                {choice.unavailableReason ?? "Unavailable on this device."}
              </p>
              {choice.links?.length ? (
                <div className="cx-links">
                  {choice.links.map((link) => {
                    const url = nativePublicUrl(link.url);
                    return url ? (
                      <OutLink key={link.url} href={url}>
                        {link.label}
                      </OutLink>
                    ) : null;
                  })}
                </div>
              ) : null}
            </div>
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
