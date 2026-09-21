/**
 * Form fields for Settings › Connections › AWS KMS.
 */

import { useId } from "react";
import { fieldGuidance } from "../../lib/connector-guidance.js";

export type AwsKmsFormState = {
  keyArn: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  label: string;
};

export function emptyAwsKmsForm(): AwsKmsFormState {
  return {
    keyArn: "",
    region: "",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
    label: "",
  };
}

function KeyAndRegionFields({
  form,
  onChange,
}: {
  form: AwsKmsFormState;
  onChange: (key: keyof AwsKmsFormState, value: string) => void;
}) {
  const keyArnId = useId();
  const regionId = useId();
  const keyArnHelp = fieldGuidance({
    name: "key_arn",
    label: "Key ARN",
    secret: false,
    required: true,
  });
  const regionHelp = fieldGuidance({
    name: "region",
    label: "Region",
    secret: false,
    required: true,
  });
  return (
    <>
      <div className="field">
        <label className="label conn-field-label" htmlFor={keyArnId}>
          Key ARN (required)
        </label>
        <input
          id={keyArnId}
          name="key_arn"
          type="text"
          autoComplete="off"
          required
          spellCheck={false}
          placeholder={keyArnHelp.placeholder}
          title={keyArnHelp.help}
          aria-describedby={`${keyArnId}-help`}
          value={form.keyArn}
          onChange={(event) => onChange("keyArn", event.target.value)}
        />
        <p className="hint" id={`${keyArnId}-help`}>
          {keyArnHelp.help}
        </p>
      </div>
      <div className="field">
        <label className="label conn-field-label" htmlFor={regionId}>
          Region (required)
        </label>
        <input
          id={regionId}
          name="region"
          type="text"
          autoComplete="off"
          required
          spellCheck={false}
          placeholder={regionHelp.placeholder}
          title={regionHelp.help}
          value={form.region}
          onChange={(event) => onChange("region", event.target.value)}
        />
      </div>
    </>
  );
}

function CredentialFields({
  form,
  configured,
  onChange,
}: {
  form: AwsKmsFormState;
  configured: boolean;
  onChange: (key: keyof AwsKmsFormState, value: string) => void;
}) {
  const accessKeyId = useId();
  const secretId = useId();
  const accessHelp = fieldGuidance({
    name: "access_key_id",
    label: "Access key ID",
    secret: false,
    required: true,
  });
  const secretHelp = fieldGuidance({
    name: "secret_access_key",
    label: "Secret access key",
    secret: true,
    required: true,
  });
  return (
    <>
      <div className="field">
        <label className="label conn-field-label" htmlFor={accessKeyId}>
          Access key ID (required)
        </label>
        <input
          id={accessKeyId}
          name="access_key_id"
          type="text"
          autoComplete="off"
          required
          spellCheck={false}
          placeholder={accessHelp.placeholder}
          title={accessHelp.help}
          value={form.accessKeyId}
          onChange={(event) => onChange("accessKeyId", event.target.value)}
        />
      </div>
      <div className="field">
        <label className="label conn-field-label" htmlFor={secretId}>
          Secret access key
          {configured ? " (leave blank to keep)" : " (required)"}
        </label>
        <input
          id={secretId}
          name="secret_access_key"
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
          value={form.secretAccessKey}
          onChange={(event) => onChange("secretAccessKey", event.target.value)}
        />
      </div>
    </>
  );
}

function OptionalFields({
  form,
  onChange,
}: {
  form: AwsKmsFormState;
  onChange: (key: keyof AwsKmsFormState, value: string) => void;
}) {
  const sessionId = useId();
  const labelId = useId();
  const sessionHelp = fieldGuidance({
    name: "session_token",
    label: "Session token",
    secret: true,
    required: false,
  });
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
      <div className="field">
        <label className="label" htmlFor={sessionId}>
          Session token
        </label>
        <input
          id={sessionId}
          name="session_token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={sessionHelp.placeholder}
          title={sessionHelp.help}
          value={form.sessionToken}
          onChange={(event) => onChange("sessionToken", event.target.value)}
        />
      </div>
    </details>
  );
}

export function AwsKmsConnectFields({
  form,
  configured,
  onChange,
}: {
  form: AwsKmsFormState;
  configured: boolean;
  onChange: (key: keyof AwsKmsFormState, value: string) => void;
}) {
  return (
    <>
      <KeyAndRegionFields form={form} onChange={onChange} />
      <CredentialFields
        form={form}
        configured={configured}
        onChange={onChange}
      />
      <OptionalFields form={form} onChange={onChange} />
    </>
  );
}
