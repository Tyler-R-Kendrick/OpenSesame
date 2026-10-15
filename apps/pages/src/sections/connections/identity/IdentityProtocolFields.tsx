import { useId } from "react";
import {
  IdentityDraftFields,
  type IdentityFieldProps,
  LDAP_FIELDS,
  LDAP_OPTIONS,
  OIDC_FIELDS,
  OIDC_OPTIONS,
  SAML_FIELDS,
  TOKEN_FIELDS,
} from "./identity-field-definitions.js";

function OidcFields(props: IdentityFieldProps) {
  return (
    <>
      <IdentityDraftFields {...props} fields={OIDC_FIELDS} />
      <details className="conn-client-alt">
        <summary>Sign-in options</summary>
        <div className="cx-form">
          <IdentityDraftFields {...props} fields={OIDC_OPTIONS} />
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
      return <IdentityDraftFields {...props} fields={SAML_FIELDS} />;
    case "ldap":
      return <LdapFields {...props} />;
    default:
      return <SessionFields {...props} />;
  }
}
