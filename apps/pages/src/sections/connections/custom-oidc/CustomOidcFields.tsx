/**
 * The custom OIDC connector's configuration fields: endpoints, the client and
 * how it authenticates at the token endpoint. The editor that owns the state
 * is `useCustomOidcEditor` in CustomOidcConnector.tsx.
 */

import type { OidcConnectorConfig } from "@opensesame/app-core/lib/custom-oidc.js";

export type OidcFieldEditor = {
  config: OidcConnectorConfig;
  set: <K extends keyof OidcConnectorConfig>(
    key: K,
    value: OidcConnectorConfig[K],
  ) => void;
  busy: boolean;
  discover: () => Promise<void>;
};

export function OidcEndpointFields({ editor }: { editor: OidcFieldEditor }) {
  const { config, set, busy, discover } = editor;
  return (
    <>
      <div className="field">
        <label htmlFor="oidc-issuer">Issuer URL</label>
        <input
          id="oidc-issuer"
          value={config.issuer}
          placeholder="https://accounts.example.com"
          onChange={(event) => set("issuer", event.target.value)}
        />
      </div>
      <button
        type="button"
        className="btn btn--sm"
        disabled={busy}
        onClick={() => void discover()}
      >
        Discover endpoints
      </button>
      <div className="field">
        <label htmlFor="oidc-authorization">Authorization endpoint</label>
        <input
          id="oidc-authorization"
          value={config.authorizationEndpoint}
          onChange={(event) => set("authorizationEndpoint", event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="oidc-token">Token endpoint</label>
        <input
          id="oidc-token"
          value={config.tokenEndpoint}
          onChange={(event) => set("tokenEndpoint", event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="oidc-jwks">JWKS URI</label>
        <input
          id="oidc-jwks"
          value={config.jwksUri}
          onChange={(event) => set("jwksUri", event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="oidc-device">Device authorization endpoint</label>
        <input
          id="oidc-device"
          value={config.deviceAuthorizationEndpoint ?? ""}
          onChange={(event) =>
            set("deviceAuthorizationEndpoint", event.target.value)
          }
        />
      </div>
    </>
  );
}

export function OidcClientFields({ editor }: { editor: OidcFieldEditor }) {
  const { config, set } = editor;
  return (
    <>
      <div className="field">
        <label htmlFor="oidc-client">Client ID</label>
        <input
          id="oidc-client"
          value={config.clientId}
          onChange={(event) => set("clientId", event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="oidc-secret">Client secret</label>
        <input
          id="oidc-secret"
          type="password"
          value={config.clientSecret}
          onChange={(event) => set("clientSecret", event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="oidc-callback">Callback URL</label>
        <input
          id="oidc-callback"
          value={config.callbackUrl}
          placeholder="https://your-tunnel.example/oidc/callback"
          onChange={(event) => set("callbackUrl", event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="oidc-relay">Token relay URL (optional)</label>
        <input
          id="oidc-relay"
          value={config.tokenRelayUrl}
          placeholder="https://relay.example/oidc/token"
          onChange={(event) => set("tokenRelayUrl", event.target.value)}
        />
        <p className="hint">
          Use a relay you control to keep the client secret off this device. The
          relay receives the same authorization-code form and performs the
          exchange at the token endpoint.
        </p>
      </div>
      <div className="field">
        <label htmlFor="oidc-scopes">Scopes</label>
        <input
          id="oidc-scopes"
          value={config.scopes.join(" ")}
          onChange={(event) =>
            set("scopes", event.target.value.split(/\s+/u).filter(Boolean))
          }
        />
      </div>
    </>
  );
}

export function OidcTokenAuthentication({
  editor,
}: { editor: OidcFieldEditor }) {
  const { config, set } = editor;
  return (
    <div className="field">
      <label htmlFor="oidc-auth">Token endpoint authentication</label>
      <select
        id="oidc-auth"
        value={config.tokenAuth}
        onChange={(event) => {
          const value = event.target.value;
          if (
            value === "none" ||
            value === "client_secret_basic" ||
            value === "client_secret_post"
          )
            set("tokenAuth", value);
        }}
      >
        <option value="none">Public client (PKCE)</option>
        <option value="client_secret_basic">Client secret in HTTP Basic</option>
        <option value="client_secret_post">
          Client secret in request body
        </option>
      </select>
    </div>
  );
}
