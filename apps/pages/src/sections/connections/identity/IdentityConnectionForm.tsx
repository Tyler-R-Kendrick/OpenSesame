import { env } from "@opensesame/app-core/host.js";
import { redirectUri } from "@opensesame/app-core/lib/federation.js";
import { identityConnectionPreset } from "@opensesame/app-core/lib/identity-connections-presets.js";
import type { IdentityConnectionDraft } from "@opensesame/app-core/lib/identity-connections-schema.js";
import {
  NATIVE_OIDC_SETUP,
  isNativeOidcConfiguration,
  nativeOidcCallbackUri,
} from "@opensesame/app-core/lib/identity-oidc-config.js";
import { type FormEvent, useId } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconCheck, IconCopy, IconRefresh } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { IdentityConnectionFields } from "./IdentityConnectionFields.js";
import type { IdentityServiceFieldProps } from "./IdentityServiceFields.js";
import { identityProtocolLabel } from "./identity-ui-values.js";

type Props = IdentityServiceFieldProps & {
  online: boolean;
  failure: string;
  saved: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onTest: () => void;
  onReload: () => void;
};
function ProtocolField({ draft, busy, onChange }: IdentityServiceFieldProps) {
  const id = useId();
  const preset = identityConnectionPreset(draft.providerId);
  return (
    <div className="field">
      <label htmlFor={`${id}-protocol`}>Protocol</label>
      <select
        id={`${id}-protocol`}
        value={draft.protocol}
        disabled={busy}
        onChange={(event) => onChange("protocol", event.target.value)}
      >
        {preset?.protocols.map((protocol) => (
          <option key={protocol} value={protocol}>
            {identityProtocolLabel(protocol, draft.providerId)}
          </option>
        ))}
      </select>
    </div>
  );
}
function CallbackField({ draft }: { draft: IdentityConnectionDraft }) {
  const protocol = draft.protocol;
  const saml = protocol === "saml";
  const oidc = protocol === "oidc";
  const value = saml
    ? new URL(
        "auth/native-saml",
        new URL(env().BASE_URL || "/", window.location.origin),
      ).href
    : oidc
      ? isNativeOidcConfiguration(draft)
        ? nativeOidcCallbackUri(window.location.origin, env().BASE_URL)
        : redirectUri()
      : window.location.origin;
  return (
    <FieldShell
      label={
        saml
          ? "SAML ACS URL to register"
          : oidc
            ? "Redirect URI to register"
            : "Allowed browser origin"
      }
      type="url"
      mono
      readOnly
      value={value}
      tail={
        <IconKey
          label={
            saml
              ? "Copy ACS URL"
              : oidc
                ? "Copy redirect URI"
                : "Copy browser origin"
          }
          onClick={() => {
            void navigator.clipboard?.writeText(value).catch(() => {});
          }}
        >
          <IconCopy size={17} />
        </IconKey>
      }
    />
  );
}
function ConfigurationCommit({
  busy,
  online,
  failure,
  saved,
  onTest,
  onReload,
}: Props) {
  return (
    <FormCommit
      label={busy ? "Saving identity connection…" : "Save identity connection"}
      busy={busy}
      disabled={busy}
    >
      <IconKey
        label="Test identity connection"
        disabled={busy || !online}
        onClick={onTest}
      >
        <IconCheck size={17} />
      </IconKey>
      {saved ? (
        <IconKey
          label="Reload identity configuration"
          disabled={busy}
          onClick={onReload}
        >
          <IconRefresh size={17} />
        </IconKey>
      ) : null}
      {failure ? <StatusMark tone="err" label={failure} /> : null}
    </FormCommit>
  );
}
/** Partner presets compose the same fields, callback and commit controls. */
export function IdentityConnectionForm(props: Props) {
  const { draft, busy, onChange } = props;
  const preset = identityConnectionPreset(draft.providerId);
  if (!preset) return null;
  return (
    <form className="cx-form panel__body" onSubmit={props.onSubmit}>
      <FieldShell
        label="Connection name"
        value={draft.name}
        disabled={busy}
        onValueChange={(value) => onChange("name", value)}
      />
      <ProtocolField {...props} />
      <CallbackField draft={draft} />
      <IdentityConnectionFields {...props} />
      <details className="conn-client-alt">
        <summary>Setup guide</summary>
        <p>
          {draft.protocol === "saml"
            ? "Register this service provider entity ID and ACS URL with your IdP. Use its metadata URL or paste its metadata XML. Enable HTTP-POST responses with RSA-SHA256 signatures. If the IdP requires signed requests, supply your SP signing key and matching certificate under SAML options. Testing checks configuration; complete sign-in to authenticate. Your existing vault still uses its normal unlock method."
            : isNativeOidcConfiguration(draft)
              ? NATIVE_OIDC_SETUP
              : preset.setup}
        </p>
        <a href={preset.docsUrl} target="_blank" rel="noreferrer noopener">
          {preset.label} documentation
        </a>
      </details>
      <ConfigurationCommit {...props} />
    </form>
  );
}
