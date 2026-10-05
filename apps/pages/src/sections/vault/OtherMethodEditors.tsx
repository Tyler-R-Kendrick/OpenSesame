import type {
  ApiKeyMethod,
  AuthenticatorMethod,
  OAuthMethod,
  TokenMethod,
} from "@opensesame/vault-core";
import { SecretInput, TextInput } from "./SecretInput.js";

/** The fields of the login methods that hold plain values; the password has its own editor. */
export function ApiKeyFields({
  method,
  onChange,
}: { method: ApiKeyMethod; onChange: (next: ApiKeyMethod) => void }) {
  return (
    <>
      <SecretInput
        id={`${method.id}-key`}
        label="API key"
        value={method.key}
        onChange={(key) => onChange({ ...method, key })}
      />
      <TextInput
        id={`${method.id}-header`}
        label="Header name"
        value={method.header}
        placeholder="X-Api-Key"
        onChange={(header) => onChange({ ...method, header })}
      />
    </>
  );
}

export function TokenFields({
  method,
  onChange,
}: { method: TokenMethod; onChange: (next: TokenMethod) => void }) {
  return (
    <>
      <SecretInput
        id={`${method.id}-token`}
        label="Token"
        value={method.token}
        onChange={(token) => onChange({ ...method, token })}
      />
      <TextInput
        id={`${method.id}-expires`}
        label="Expires"
        value={method.expiresAt}
        placeholder="2027-01-31T00:00:00Z"
        onChange={(expiresAt) => onChange({ ...method, expiresAt })}
      />
    </>
  );
}

export function OAuthFields({
  method,
  onChange,
}: { method: OAuthMethod; onChange: (next: OAuthMethod) => void }) {
  return (
    <>
      <TextInput
        id={`${method.id}-client`}
        label="Client id"
        value={method.clientId}
        onChange={(clientId) => onChange({ ...method, clientId })}
      />
      <SecretInput
        id={`${method.id}-secret`}
        label="Client secret"
        value={method.clientSecret}
        onChange={(clientSecret) => onChange({ ...method, clientSecret })}
      />
      <TextInput
        id={`${method.id}-url`}
        label="Token URL"
        value={method.tokenUrl}
        placeholder="https://example.com/oauth/token"
        onChange={(tokenUrl) => onChange({ ...method, tokenUrl })}
      />
      <TextInput
        id={`${method.id}-scopes`}
        label="Scopes"
        value={method.scopes}
        placeholder="read write"
        onChange={(scopes) => onChange({ ...method, scopes })}
      />
      <SecretInput
        id={`${method.id}-refresh`}
        label="Refresh token"
        value={method.refreshToken}
        onChange={(refreshToken) => onChange({ ...method, refreshToken })}
      />
    </>
  );
}

export function AuthenticatorFields({
  method,
  onChange,
}: {
  method: AuthenticatorMethod;
  onChange: (next: AuthenticatorMethod) => void;
}) {
  return (
    <SecretInput
      id={`${method.id}-seed`}
      label="Authenticator secret"
      value={method.secret}
      placeholder="Base32 seed or otpauth:// URI"
      onChange={(secret) => onChange({ ...method, secret })}
    />
  );
}
