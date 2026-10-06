import type {
  ApiKeyMethod,
  AuthenticatorMethod,
  LoginMethod,
  OAuthMethod,
  TokenMethod,
} from "@opensesame/vault-core";
import { CredentialLine } from "./CredentialLine.js";
import { SecretControl, TextControl } from "./SecretInput.js";
import { apiKeyLabels } from "./credential-labels.js";

/** What a credential's lines need beyond its own fields: its name and its remove key. */
type Lines<T extends LoginMethod> = {
  method: T;
  /** The account's credentials, for labels that tell one of a kind from another. */
  methods: readonly LoginMethod[];
  /** The type's title, numbered when there are several: `API key 2`. */
  title: string;
  onChange: (next: T) => void;
  onRemove: () => void;
};

const removal = (title: string, onRemove: () => void) => ({
  label: `Remove ${title.toLowerCase()}`,
  onRemove,
});

/** An API key: the header it travels in, then its value, one line each. */
export function ApiKeyLines({
  method,
  methods,
  title,
  onChange,
  onRemove,
}: Lines<ApiKeyMethod>) {
  const labels = apiKeyLabels(methods, method);
  return (
    <>
      <CredentialLine
        label={labels.header}
        htmlFor={`${method.id}-header`}
        remove={removal(title, onRemove)}
        field={
          <TextControl
            id={`${method.id}-header`}
            value={method.header}
            placeholder="X-Api-Key"
            onChange={(header) => onChange({ ...method, header })}
          />
        }
      />
      <CredentialLine
        label={labels.value}
        htmlFor={`${method.id}-key`}
        field={
          <SecretControl
            id={`${method.id}-key`}
            label={labels.value}
            value={method.key}
            onChange={(key) => onChange({ ...method, key })}
          />
        }
      />
    </>
  );
}

export function TokenLines({
  method,
  title,
  onChange,
  onRemove,
}: Lines<TokenMethod>) {
  return (
    <>
      <CredentialLine
        label={title}
        htmlFor={`${method.id}-token`}
        remove={removal(title, onRemove)}
        field={
          <SecretControl
            id={`${method.id}-token`}
            label={title}
            value={method.token}
            onChange={(token) => onChange({ ...method, token })}
          />
        }
      />
      <CredentialLine
        label="Expires"
        htmlFor={`${method.id}-expires`}
        field={
          <TextControl
            id={`${method.id}-expires`}
            value={method.expiresAt}
            placeholder="2027-01-31T00:00:00Z"
            onChange={(expiresAt) => onChange({ ...method, expiresAt })}
          />
        }
      />
    </>
  );
}

export function OAuthLines({
  method,
  title,
  onChange,
  onRemove,
}: Lines<OAuthMethod>) {
  return (
    <>
      <CredentialLine
        label="Client id"
        htmlFor={`${method.id}-client`}
        remove={removal(title, onRemove)}
        field={
          <TextControl
            id={`${method.id}-client`}
            value={method.clientId}
            onChange={(clientId) => onChange({ ...method, clientId })}
          />
        }
      />
      <CredentialLine
        label="Client secret"
        htmlFor={`${method.id}-secret`}
        field={
          <SecretControl
            id={`${method.id}-secret`}
            label="Client secret"
            value={method.clientSecret}
            onChange={(clientSecret) => onChange({ ...method, clientSecret })}
          />
        }
      />
      <CredentialLine
        label="Token URL"
        htmlFor={`${method.id}-url`}
        field={
          <TextControl
            id={`${method.id}-url`}
            value={method.tokenUrl}
            placeholder="https://example.com/oauth/token"
            onChange={(tokenUrl) => onChange({ ...method, tokenUrl })}
          />
        }
      />
      <CredentialLine
        label="Scopes"
        htmlFor={`${method.id}-scopes`}
        field={
          <TextControl
            id={`${method.id}-scopes`}
            value={method.scopes}
            placeholder="read write"
            onChange={(scopes) => onChange({ ...method, scopes })}
          />
        }
      />
      <CredentialLine
        label="Refresh token"
        htmlFor={`${method.id}-refresh`}
        field={
          <SecretControl
            id={`${method.id}-refresh`}
            label="Refresh token"
            value={method.refreshToken}
            onChange={(refreshToken) => onChange({ ...method, refreshToken })}
          />
        }
      />
    </>
  );
}

export function AuthenticatorLines({
  method,
  title,
  onChange,
  onRemove,
}: Lines<AuthenticatorMethod>) {
  return (
    <CredentialLine
      label="Authenticator secret"
      htmlFor={`${method.id}-seed`}
      remove={removal(title, onRemove)}
      field={
        <SecretControl
          id={`${method.id}-seed`}
          label="Authenticator secret"
          value={method.secret}
          placeholder="Base32 seed or otpauth:// URI"
          onChange={(secret) => onChange({ ...method, secret })}
        />
      }
    />
  );
}
