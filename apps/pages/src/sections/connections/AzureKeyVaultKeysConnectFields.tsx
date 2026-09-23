/**
 * Form fields for Settings › Connections › Azure Key Vault Keys.
 */

import { fieldGuidance } from "@opensesame/app-core/lib/connector-guidance.js";
import { useId } from "react";

export type AzureKeyVaultKeysFormState = {
  versionedKeyId: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  label: string;
};

export function emptyAzureKeyVaultKeysForm(): AzureKeyVaultKeysFormState {
  return {
    versionedKeyId: "",
    tenantId: "",
    clientId: "",
    clientSecret: "",
    label: "",
  };
}

function KeyIdField({
  form,
  onChange,
}: {
  form: AzureKeyVaultKeysFormState;
  onChange: (key: keyof AzureKeyVaultKeysFormState, value: string) => void;
}) {
  const keyId = useId();
  const help = {
    help: "HTTPS versioned key id (/keys/{name}/{version}), not a secret or certificate URL.",
    placeholder: "https://….vault.azure.net/keys/…/…",
  };
  return (
    <div className="field">
      <label className="label conn-field-label" htmlFor={keyId}>
        Versioned key ID (required)
      </label>
      <input
        id={keyId}
        name="versioned_key_id"
        type="text"
        autoComplete="off"
        required
        spellCheck={false}
        placeholder={help.placeholder}
        title={help.help}
        aria-describedby={`${keyId}-help`}
        value={form.versionedKeyId}
        onChange={(event) => onChange("versionedKeyId", event.target.value)}
      />
      <p className="hint" id={`${keyId}-help`}>
        {help.help}
      </p>
    </div>
  );
}

function IdentityFields({
  form,
  configured,
  onChange,
}: {
  form: AzureKeyVaultKeysFormState;
  configured: boolean;
  onChange: (key: keyof AzureKeyVaultKeysFormState, value: string) => void;
}) {
  const tenantId = useId();
  const clientId = useId();
  const secretId = useId();
  const tenantHelp = fieldGuidance({
    name: "tenant_id",
    label: "Tenant ID",
    secret: false,
    required: true,
  });
  const clientHelp = fieldGuidance({
    name: "client_id",
    label: "Client ID",
    secret: false,
    required: true,
  });
  const secretHelp = fieldGuidance({
    name: "client_secret",
    label: "Client secret",
    secret: true,
    required: true,
  });
  return (
    <>
      <div className="field">
        <label className="label conn-field-label" htmlFor={tenantId}>
          Tenant ID (required)
        </label>
        <input
          id={tenantId}
          name="tenant_id"
          type="text"
          autoComplete="off"
          required
          spellCheck={false}
          placeholder={tenantHelp.placeholder}
          title={tenantHelp.help}
          value={form.tenantId}
          onChange={(event) => onChange("tenantId", event.target.value)}
        />
      </div>
      <div className="field">
        <label className="label conn-field-label" htmlFor={clientId}>
          Client ID (required)
        </label>
        <input
          id={clientId}
          name="client_id"
          type="text"
          autoComplete="off"
          required
          spellCheck={false}
          placeholder={clientHelp.placeholder}
          title={clientHelp.help}
          value={form.clientId}
          onChange={(event) => onChange("clientId", event.target.value)}
        />
      </div>
      <div className="field">
        <label className="label conn-field-label" htmlFor={secretId}>
          Client secret
          {configured ? " (leave blank to keep)" : " (required)"}
        </label>
        <input
          id={secretId}
          name="client_secret"
          type="password"
          autoComplete="new-password"
          required={!configured}
          spellCheck={false}
          placeholder={
            configured
              ? "Leave blank to keep sealed secret"
              : secretHelp.placeholder
          }
          title={secretHelp.help}
          value={form.clientSecret}
          onChange={(event) => onChange("clientSecret", event.target.value)}
        />
      </div>
    </>
  );
}

function OptionalFields({
  form,
  onChange,
}: {
  form: AzureKeyVaultKeysFormState;
  onChange: (key: keyof AzureKeyVaultKeysFormState, value: string) => void;
}) {
  const labelId = useId();
  return (
    <details className="conn-client-alt">
      <summary>Optional settings</summary>
      <div className="field">
        <label className="label" htmlFor={labelId}>
          Name
        </label>
        <input
          id={labelId}
          value={form.label}
          onChange={(event) => onChange("label", event.target.value)}
        />
      </div>
    </details>
  );
}

export function AzureKeyVaultKeysConnectFields({
  form,
  configured,
  onChange,
}: {
  form: AzureKeyVaultKeysFormState;
  configured: boolean;
  onChange: (key: keyof AzureKeyVaultKeysFormState, value: string) => void;
}) {
  return (
    <>
      <KeyIdField form={form} onChange={onChange} />
      <IdentityFields form={form} configured={configured} onChange={onChange} />
      <OptionalFields form={form} onChange={onChange} />
    </>
  );
}
