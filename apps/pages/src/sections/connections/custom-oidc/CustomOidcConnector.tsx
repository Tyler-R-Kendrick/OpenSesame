import {
  type OidcConnectorConfig,
  type OidcDeviceAuthorization,
  type OidcPending,
  type OidcTokens,
  beginOidcDevice,
  beginOidcLogin,
  completeOidcLogin,
  discoverOidc,
  oidcConnectorItem,
  pollOidcDevice,
} from "@opensesame/app-core/lib/custom-oidc.js";
import { useState } from "react";
import { Link } from "react-router";
import { IconChevronLeft, IconPlus } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useVaultStore } from "../../../lib/vault/hooks.js";

const EMPTY: OidcConnectorConfig = {
  name: "",
  issuer: "",
  authorizationEndpoint: "",
  tokenEndpoint: "",
  jwksUri: "",
  deviceAuthorizationEndpoint: "",
  clientId: "",
  clientSecret: "",
  callbackUrl: "",
  tokenRelayUrl: "",
  scopes: ["openid", "profile", "email"],
  tokenAuth: "client_secret_post",
};

export function CustomOidcConnector() {
  const store = useVaultStore();
  const [config, setConfig] = useState(EMPTY);
  const [pending, setPending] = useState<OidcPending | null>(null);
  const [device, setDevice] = useState<OidcDeviceAuthorization | null>(null);
  const [callback, setCallback] = useState("");
  const [tokens, setTokens] = useState<OidcTokens | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const set = <K extends keyof OidcConnectorConfig>(
    key: K,
    value: OidcConnectorConfig[K],
  ) => setConfig((current) => ({ ...current, [key]: value }));

  async function discover() {
    setBusy(true);
    setFailure(null);
    try {
      const found = await discoverOidc(config.issuer);
      setConfig((current) => ({ ...current, ...found }));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Discovery failed");
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setBusy(true);
    setFailure(null);
    try {
      const started = await beginOidcLogin(config);
      setPending(started.pending);
      setCallback("");
      window.open(started.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : "Could not start OIDC",
      );
    } finally {
      setBusy(false);
    }
  }

  async function startDevice() {
    setBusy(true);
    setFailure(null);
    try {
      const authorization = await beginOidcDevice(config);
      setDevice(authorization);
      window.open(
        authorization.verificationUriComplete ?? authorization.verificationUri,
        "_blank",
        "noopener,noreferrer",
      );
      let interval = authorization.intervalSeconds;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, interval * 1000));
        const result = await pollOidcDevice(config, authorization);
        if (result.status === "pending") {
          interval = result.intervalSeconds;
          continue;
        }
        setTokens(result.tokens);
        await store.addItems([oidcConnectorItem(config, result.tokens)]);
        setSaved(true);
        setDevice(null);
        break;
      }
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : "Device authorization failed",
      );
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (!pending) return;
    setBusy(true);
    setFailure(null);
    try {
      const received = await completeOidcLogin(pending, callback);
      setTokens(received);
      await store.addItems([oidcConnectorItem(config, received)]);
      setSaved(true);
      setPending(null);
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : "OIDC exchange failed",
      );
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setFailure(null);
    try {
      await store.addItems([oidcConnectorItem(config, tokens ?? undefined)]);
      setSaved(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section__inner conn-settings">
      <Link className="conn-back" to="/connections">
        <IconChevronLeft size={16} /> Connections
      </Link>
      <header className="conn-settings__head">
        <div className="conn-settings__title">
          <h1>Custom OIDC connector</h1>
          <p>
            Register an OIDC application with your provider, then keep its
            configuration sealed in this vault.
          </p>
        </div>
      </header>
      <div className="panel">
        <div className="panel__body">
          <div className="field">
            <label htmlFor="oidc-name">Connection name</label>
            <input
              id="oidc-name"
              value={config.name}
              onChange={(event) => set("name", event.target.value)}
            />
          </div>
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
              onChange={(event) =>
                set("authorizationEndpoint", event.target.value)
              }
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
              Use a relay you control to keep the client secret off this device.
              The relay receives the same authorization-code form and performs
              the exchange at the token endpoint.
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
              <option value="client_secret_basic">
                Client secret in HTTP Basic
              </option>
              <option value="client_secret_post">
                Client secret in request body
              </option>
            </select>
          </div>
          <div className="button-row">
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={busy}
              onClick={() => void start()}
            >
              <IconPlus size={14} /> Start sign-in
            </button>
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy}
              onClick={() => void save()}
            >
              Save encrypted
            </button>
          </div>
          {config.deviceAuthorizationEndpoint ? (
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy}
              onClick={() => void startDevice()}
            >
              Use device code
            </button>
          ) : null}
          {device ? (
            <output className="note note--ok">
              Open {device.verificationUri} and enter{" "}
              <strong>{device.userCode}</strong>. Waiting for approval…
            </output>
          ) : null}
          {pending ? (
            <div className="field">
              <label htmlFor="oidc-callback-result">
                Paste the callback URL
              </label>
              <input
                id="oidc-callback-result"
                value={callback}
                onChange={(event) => setCallback(event.target.value)}
              />
              <button
                type="button"
                className="btn btn--sm"
                disabled={busy || !callback}
                onClick={() => void finish()}
              >
                Complete exchange
              </button>
            </div>
          ) : null}
          {failure ? <StatusMark tone="err" label={failure} /> : null}
          {saved ? <StatusMark tone="ok" label="Sealed in the vault" /> : null}
        </div>
      </div>
    </div>
  );
}
