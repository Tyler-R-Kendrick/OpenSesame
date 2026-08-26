import { type FormEvent, useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import { IconAlert, IconChevronLeft } from "../../components/Icons.js";
import type { CustomProviderAuth } from "../../lib/connections.js";
import { createCustomProvider } from "../../lib/connections.js";
import { hostBase } from "../../lib/identity.js";
import { useOnline } from "../../lib/use-online.js";
import { connectorPath, errorText } from "./shared.js";

export function slugify(name: string): string {
  const slug = name
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug ? `custom-${slug}` : "";
}

/**
 * Register any HTTPS service with standard auth as a connector — an MCP
 * server, an OpenAPI backend, an internal API. The definition holds no
 * secrets: an OAuth client is sealed afterwards on the connector page, and an
 * API key when connecting.
 */
export function CustomConnectorPage() {
  const online = useOnline();
  const navigate = useNavigate();
  const fieldId = useId();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [kind, setKind] = useState<"oauth2_authorization_code" | "api_key">(
    "oauth2_authorization_code",
  );
  const [authorizeUrl, setAuthorizeUrl] = useState("");
  const [tokenUrl, setTokenUrl] = useState("");
  const [supportsRefresh, setSupportsRefresh] = useState(true);
  const [scopes, setScopes] = useState("");
  const [header, setHeader] = useState("Authorization");
  const [valuePrefix, setValuePrefix] = useState("Bearer ");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const id = slugify(name);
  const callback = `${hostBase()}/api/v1/oauth/callback/${id || "custom-…"}`;

  const complete =
    id !== "" &&
    baseUrl.trim() !== "" &&
    (kind === "api_key"
      ? header.trim() !== ""
      : authorizeUrl.trim() !== "" && tokenUrl.trim() !== "");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!complete) return;
    const auth: CustomProviderAuth =
      kind === "oauth2_authorization_code"
        ? {
            kind,
            authorizeUrl: authorizeUrl.trim(),
            tokenUrl: tokenUrl.trim(),
            supportsRefresh,
            scopes: scopes.split(/[\s,]+/).filter(Boolean),
          }
        : { kind, header: header.trim(), valuePrefix };
    setBusy(true);
    setError(null);
    try {
      const provider = await createCustomProvider({
        id,
        displayName: name.trim(),
        baseUrl: baseUrl.trim(),
        auth,
      });
      navigate(connectorPath(provider.id));
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section__inner conn-settings">
      <Link className="conn-back" to="/connections">
        <IconChevronLeft size={16} /> Connections
      </Link>
      <header className="section__head">
        <h1>Custom connector</h1>
        <p>
          Any service with OAuth 2.0 or API-key auth — an MCP server, an OpenAPI
          backend, an internal API. Its credential can only ever be sent to the
          base URL you set here.
        </p>
      </header>

      {error ? (
        <p className="note note--err" role="alert">
          <IconAlert /> {error}
        </p>
      ) : null}

      <form
        className="panel conn-custom-form"
        onSubmit={(event) => void submit(event)}
      >
        <div className="panel__body">
          <div className="conn-custom-grid">
            <div className="field">
              <label className="label" htmlFor={`${fieldId}-name`}>
                Name
              </label>
              <input
                id={`${fieldId}-name`}
                value={name}
                placeholder="Acme MCP"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor={`${fieldId}-slug`}>
                ID
              </label>
              <input
                id={`${fieldId}-slug`}
                value={id}
                readOnly
                placeholder="custom-…"
                className="conn-custom-slug"
              />
            </div>
          </div>

          <div className="field">
            <label className="label" htmlFor={`${fieldId}-base`}>
              Base URL
            </label>
            <input
              id={`${fieldId}-base`}
              type="url"
              value={baseUrl}
              spellCheck={false}
              placeholder="https://mcp.acme.dev"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
            <p className="hint">
              HTTPS only. Requests through this connector can only reach this
              origin.
            </p>
          </div>

          <fieldset className="field">
            <legend className="label">Authentication</legend>
            <div className="conn-custom-kind" role="radiogroup">
              <label className="check">
                <input
                  type="radio"
                  name={`${fieldId}-kind`}
                  checked={kind === "oauth2_authorization_code"}
                  onChange={() => setKind("oauth2_authorization_code")}
                />
                OAuth 2.0
              </label>
              <label className="check">
                <input
                  type="radio"
                  name={`${fieldId}-kind`}
                  checked={kind === "api_key"}
                  onChange={() => setKind("api_key")}
                />
                API key
              </label>
            </div>
          </fieldset>

          {kind === "oauth2_authorization_code" ? (
            <>
              <div className="conn-custom-grid">
                <div className="field">
                  <label className="label" htmlFor={`${fieldId}-auth`}>
                    Authorization URL
                  </label>
                  <input
                    id={`${fieldId}-auth`}
                    type="url"
                    value={authorizeUrl}
                    spellCheck={false}
                    placeholder="https://mcp.acme.dev/oauth/authorize"
                    onChange={(event) => setAuthorizeUrl(event.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor={`${fieldId}-token`}>
                    Token URL
                  </label>
                  <input
                    id={`${fieldId}-token`}
                    type="url"
                    value={tokenUrl}
                    spellCheck={false}
                    placeholder="https://mcp.acme.dev/oauth/token"
                    onChange={(event) => setTokenUrl(event.target.value)}
                  />
                </div>
              </div>
              <div className="field">
                <label className="label" htmlFor={`${fieldId}-scopes`}>
                  Scopes
                </label>
                <input
                  id={`${fieldId}-scopes`}
                  value={scopes}
                  spellCheck={false}
                  placeholder="tools:read tools:invoke"
                  onChange={(event) => setScopes(event.target.value)}
                />
                <label className="check">
                  <input
                    type="checkbox"
                    checked={supportsRefresh}
                    onChange={(event) =>
                      setSupportsRefresh(event.target.checked)
                    }
                  />
                  Provider issues refresh tokens
                </label>
              </div>
              <div className="conn-callback">
                <span className="conn-callback__label">Redirect URL</span>
                <code>{callback}</code>
              </div>
              <p className="hint">
                Register this redirect URL in the provider&rsquo;s app settings.
                The OAuth client id and secret are sealed on the connector page
                after this step.
              </p>
            </>
          ) : (
            <div className="conn-custom-grid">
              <div className="field">
                <label className="label" htmlFor={`${fieldId}-header`}>
                  Header
                </label>
                <input
                  id={`${fieldId}-header`}
                  value={header}
                  spellCheck={false}
                  onChange={(event) => setHeader(event.target.value)}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor={`${fieldId}-prefix`}>
                  Value prefix
                </label>
                <input
                  id={`${fieldId}-prefix`}
                  value={valuePrefix}
                  spellCheck={false}
                  placeholder="Bearer "
                  onChange={(event) => setValuePrefix(event.target.value)}
                />
                <p className="hint">
                  The key itself is pasted once on the connector page and sealed
                  on arrival.
                </p>
              </div>
            </div>
          )}

          <div className="actions">
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy || !online || !complete}
            >
              {busy ? "Creating…" : "Create connector"}
            </button>
            <Link className="btn" to="/connections">
              Cancel
            </Link>
          </div>
        </div>
      </form>
    </div>
  );
}
