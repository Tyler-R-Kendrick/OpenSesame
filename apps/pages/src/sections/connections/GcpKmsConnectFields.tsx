/**
 * Form fields for Settings › Connections › Google Cloud KMS.
 */

import { fieldGuidance } from "@opensesame/app-core/lib/field-guidance.js";
import { useId } from "react";

export type GcpKmsFormState = {
  keyName: string;
  projectId: string;
  serviceAccountJson: string;
  label: string;
};

export function emptyGcpKmsForm(): GcpKmsFormState {
  return {
    keyName: "",
    projectId: "",
    serviceAccountJson: "",
    label: "",
  };
}

function KeyNameField({
  form,
  locked,
  onChange,
}: {
  form: GcpKmsFormState;
  locked: boolean;
  onChange: (key: keyof GcpKmsFormState, value: string) => void;
}) {
  const keyId = useId();
  const help = {
    help: "Full crypto key resource name (projects/…/locations/…/keyRings/…/cryptoKeys/…).",
    placeholder: "projects/…/locations/…/keyRings/…/cryptoKeys/…",
  };
  return (
    <div className="field">
      <label className="label conn-field-label" htmlFor={keyId}>
        Crypto key (required)
      </label>
      <input
        id={keyId}
        name="crypto_key_name"
        type="text"
        autoComplete="off"
        required
        spellCheck={false}
        placeholder={help.placeholder}
        title={help.help}
        value={form.keyName}
        readOnly={locked}
        onChange={(event) => onChange("keyName", event.target.value)}
      />
    </div>
  );
}

function CredentialFields({
  form,
  configured,
  locked,
  onChange,
}: {
  form: GcpKmsFormState;
  configured: boolean;
  locked: boolean;
  onChange: (key: keyof GcpKmsFormState, value: string) => void;
}) {
  const projectId = useId();
  const secretId = useId();
  const projectHelp = fieldGuidance({
    name: "project_id",
    label: "Project ID",
    secret: false,
    required: true,
  });
  const secretHelp = fieldGuidance({
    name: "service_account_json",
    label: "Service account JSON",
    secret: true,
    required: true,
  });
  return (
    <>
      <div className="field">
        <label className="label conn-field-label" htmlFor={projectId}>
          Project ID (required)
        </label>
        <input
          id={projectId}
          name="project_id"
          type="text"
          autoComplete="off"
          required
          spellCheck={false}
          placeholder={projectHelp.placeholder}
          title={projectHelp.help}
          value={form.projectId}
          readOnly={locked}
          onChange={(event) => onChange("projectId", event.target.value)}
        />
      </div>
      <div className="field">
        <label className="label conn-field-label" htmlFor={secretId}>
          Service account JSON
          {configured ? " (leave blank to keep)" : " (required)"}
        </label>
        <textarea
          id={secretId}
          name="service_account_json"
          autoComplete="off"
          required={!configured}
          spellCheck={false}
          rows={4}
          placeholder={
            configured
              ? "Leave blank to keep sealed credential"
              : secretHelp.placeholder
          }
          title={secretHelp.help}
          value={form.serviceAccountJson}
          onChange={(event) =>
            onChange("serviceAccountJson", event.target.value)
          }
        />
      </div>
    </>
  );
}

function OptionalFields({
  form,
  onChange,
}: {
  form: GcpKmsFormState;
  onChange: (key: keyof GcpKmsFormState, value: string) => void;
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

export function GcpKmsConnectFields({
  form,
  configured,
  identityLocked = false,
  onChange,
}: {
  form: GcpKmsFormState;
  configured: boolean;
  /** The key a protector wraps with: drawn read-only while one is enrolled. */
  identityLocked?: boolean;
  onChange: (key: keyof GcpKmsFormState, value: string) => void;
}) {
  return (
    <>
      <KeyNameField form={form} locked={identityLocked} onChange={onChange} />
      <CredentialFields
        form={form}
        configured={configured}
        locked={identityLocked}
        onChange={onChange}
      />
      <OptionalFields form={form} onChange={onChange} />
    </>
  );
}
