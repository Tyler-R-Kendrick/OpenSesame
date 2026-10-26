import { useId } from "react";
import { NativeInputFields } from "../connect/NativeConnectorFields.js";
import { SelectField } from "../connect/fields.js";
import type { NativeField } from "../connect/native-connector-ui.js";
import {
  IdentityDraftFields,
  type IdentityFieldProps,
  LDAP_FIELDS,
  LDAP_OPTIONS,
  OIDC_FIELDS,
  OIDC_OPTIONS,
  SAML_FIELDS,
  SAML_OPTIONS,
  TOKEN_FIELDS,
} from "./identity-field-definitions.js";

const SAML_METADATA_FIELDS = [
  {
    id: "samlMetadataXml",
    label: "Metadata XML (alternative to URL)",
    kind: "textarea",
    secret: false,
    required: false,
    maxLength: 262144,
    help: "Paste IdP metadata or use its URL. Saved XML is write-only; leave it blank to keep an unchanged connection.",
  },
] as const satisfies readonly NativeField[];
const SAML_SIGNING_FIELDS = [
  {
    id: "samlSigningPrivateKeyPkcs8",
    label: "SP signing private key (PKCS8 PEM)",
    kind: "text",
    secret: true,
    required: false,
    help: "Optional unless the IdP requires signed requests. Leave blank to keep the key for an unchanged connection.",
  },
  {
    id: "samlSigningCertificate",
    label: "SP signing certificate (PEM)",
    kind: "textarea",
    secret: false,
    required: false,
    maxLength: 16384,
    help: "Use the certificate matching the private key. Changing the metadata URL or certificate requires re-entering that key.",
  },
] as const satisfies readonly NativeField[];
function SamlFields(props: IdentityFieldProps) {
  const changed: IdentityFieldProps["onChange"] = (key, value) => {
    if (value && key === "samlMetadataXml")
      props.onChange("samlMetadataUrl", "");
    if (value && key === "samlMetadataUrl")
      props.onChange("samlMetadataXml", "");
    props.onChange(key, value);
  };
  const nativeChanged = (id: string, value: string) => {
    const field = [...SAML_METADATA_FIELDS, ...SAML_SIGNING_FIELDS].find(
      (entry) => entry.id === id,
    );
    if (field) changed(field.id, value);
  };
  return (
    <>
      <IdentityDraftFields {...props} onChange={changed} fields={SAML_FIELDS} />
      <fieldset className="cx-form" disabled={props.busy}>
        <NativeInputFields
          fields={SAML_METADATA_FIELDS}
          values={props.draft}
          onChange={nativeChanged}
        />
        <details className="conn-client-alt">
          <summary>SAML options</summary>
          <div className="cx-form">
            <IdentityDraftFields {...props} fields={SAML_OPTIONS} />
            <SelectField
              label="Require fresh authentication"
              value={props.draft.samlForceAuthentication}
              options={[
                { id: "false", label: "No" },
                { id: "true", label: "Yes" },
              ]}
              onChange={(value) => changed("samlForceAuthentication", value)}
            />
            <NativeInputFields
              fields={SAML_SIGNING_FIELDS}
              values={props.draft}
              onChange={nativeChanged}
            />
          </div>
        </details>
      </fieldset>
    </>
  );
}

function OidcFields(props: IdentityFieldProps) {
  const confidential =
    props.draft.oidcClientType === "confidential" || !!props.draft.clientSecret;
  const changed: IdentityFieldProps["onChange"] = (key, value) => {
    if (key === "clientSecret" && value)
      props.onChange("oidcClientType", "confidential");
    props.onChange(key, value);
  };
  return (
    <>
      <fieldset className="cx-form" disabled={props.busy}>
        <SelectField
          label="OIDC client type"
          value={confidential ? "confidential" : "public"}
          options={[
            { id: "public", label: "Public client" },
            { id: "confidential", label: "Confidential client" },
          ]}
          onChange={(value) => {
            if (value === "public") props.onChange("clientSecret", "");
            props.onChange("oidcClientType", value);
          }}
        />
      </fieldset>
      <IdentityDraftFields
        {...props}
        fields={OIDC_FIELDS.map((field) =>
          field.key === "clientId" && confidential
            ? { ...field, label: "Client ID" }
            : field,
        )}
      />
      <details className="conn-client-alt">
        <summary>Sign-in options</summary>
        <div className="cx-form">
          <IdentityDraftFields
            {...props}
            onChange={changed}
            fields={OIDC_OPTIONS.filter(
              (field) => field.key !== "clientSecret" || confidential,
            )}
          />
          <IdentityDraftFields
            {...props}
            fields={[
              { key: "organizationId", label: "Organization ID (optional)" },
              {
                key: "oidcOrganizationParameter",
                label: "Organization authorization parameter",
              },
              {
                key: "oidcOrganizationClaim",
                label: "Signed organization claim",
              },
            ]}
          />
        </div>
      </details>
    </>
  );
}
function LdapFields(props: IdentityFieldProps) {
  const id = useId();
  return (
    <>
      <IdentityDraftFields {...props} fields={LDAP_FIELDS} />
      <details className="conn-client-alt">
        <summary>Directory options</summary>
        <div className="cx-form">
          <div className="field">
            <label htmlFor={`${id}-bind`}>Bind mode</label>
            <select
              id={`${id}-bind`}
              value={props.draft.ldapBindMode}
              disabled={props.busy}
              onChange={(event) =>
                props.onChange("ldapBindMode", event.target.value)
              }
            >
              <option value="bind_template">User bind</option>
              <option value="search_then_bind">Search and bind</option>
            </select>
          </div>
          <IdentityDraftFields {...props} fields={LDAP_OPTIONS} />
        </div>
      </details>
    </>
  );
}
function SessionFields(props: IdentityFieldProps) {
  const supabase = props.draft.protocol === "supabase";
  return (
    <>
      <IdentityDraftFields
        {...props}
        fields={[
          {
            key: "baseUrl",
            label: supabase ? "Project URL" : "Auth API base URL",
          },
        ]}
      />
      {supabase ? (
        <IdentityDraftFields
          {...props}
          fields={[{ key: "publicKey", label: "Publishable / anon key" }]}
        />
      ) : null}
      <details className="conn-client-alt">
        <summary>Token verification</summary>
        <div className="cx-form">
          <IdentityDraftFields {...props} fields={TOKEN_FIELDS} />
        </div>
      </details>
    </>
  );
}
export function IdentityProtocolFields(props: IdentityFieldProps) {
  switch (props.draft.protocol) {
    case "oidc":
      return <OidcFields {...props} />;
    case "saml":
      return <SamlFields {...props} />;
    case "ldap":
      return <LdapFields {...props} />;
    default:
      return <SessionFields {...props} />;
  }
}
