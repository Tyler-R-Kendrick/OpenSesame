import {
  type ByoConnectionInput,
  type ByoMethod,
  byoConnectionProblems,
  createByoConnection,
} from "@opensesame/app-core/lib/byo-connections.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { type FormEvent, useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { FieldShell } from "../../components/FieldShell.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconPlus, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { ConnectorModes } from "./connect/ConnectorModes.js";

const METHODS: readonly { id: ByoMethod; label: string }[] = [
  { id: "oauth", label: "OAuth" },
  { id: "basic", label: "Basic auth" },
  { id: "api-key", label: "API key" },
  { id: "saml", label: "SAML" },
];

const EMPTY: ByoConnectionInput = {
  name: "",
  service: "",
  method: "oauth",
  baseUrl: "",
  authorizationUrl: "",
  tokenUrl: "",
  clientId: "",
  clientSecret: "",
  username: "",
  password: "",
  apiKey: "",
  header: "X-Api-Key",
  scopes: "",
  samlEntityId: "",
  samlMetadataUrl: "",
  samlMetadataXml: "",
  samlPrivateKey: "",
  refreshToken: "",
};

/** One form for every BYO method; credentials become a vault item on save. */
export function ByoConnectionPanel({
  open,
  onClose,
  onSaved,
  onFlash,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  onFlash: (flash: Flash) => void;
}) {
  const [draft, setDraft] = useState<ByoConnectionInput>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) return null;

  const set = <Key extends keyof ByoConnectionInput>(
    key: Key,
    value: ByoConnectionInput[Key],
  ) => setDraft((current) => ({ ...current, [key]: value }));

  const problems = byoConnectionProblems(draft);

  function close() {
    if (busy) return;
    setDraft(EMPTY);
    setError(null);
    onClose();
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || problems.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      await createByoConnection(draft);
      setDraft(EMPTY);
      onFlash({ tone: "ok", text: "Connection saved in this vault." });
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Connection failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      id="byo-connection-panel"
      className="panel"
      aria-label="New connection"
    >
      <div className="panel__head">
        <h2>
          <span className="cx-step">1</span> New connection
        </h2>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close new connection"
          title="Close"
          onClick={close}
          disabled={busy}
        >
          <IconX size={17} />
        </button>
      </div>
      <form
        className="cx-form panel__body"
        aria-label="New connection configuration"
        onSubmit={(event) => void save(event)}
      >
        <fieldset className="cx-block" disabled={busy}>
          <legend className="visually-hidden">Connection details</legend>
          <FieldShell
            label="Connection name"
            value={draft.name}
            onValueChange={(name) => set("name", name)}
            placeholder="Acme API"
            autoComplete="off"
          />
          <FieldShell
            label="Service"
            value={draft.service}
            onValueChange={(service) => set("service", service)}
            placeholder="Acme"
            autoComplete="off"
          />
          <ConnectorModes
            label="Connection method"
            value={draft.method}
            options={METHODS}
            onChange={(method) => set("method", method)}
          />
          {draft.method === "oauth" ? (
            <>
              <FieldShell
                label="Base URL"
                type="url"
                mono
                value={draft.baseUrl}
                onValueChange={(baseUrl) => set("baseUrl", baseUrl)}
                placeholder="https://api.example.com"
              />
              <FieldShell
                label="Authorization URL"
                type="url"
                mono
                value={draft.authorizationUrl}
                onValueChange={(authorizationUrl) =>
                  set("authorizationUrl", authorizationUrl)
                }
                placeholder="https://api.example.com/oauth/authorize"
              />
              <FieldShell
                label="Token URL"
                type="url"
                mono
                value={draft.tokenUrl}
                onValueChange={(tokenUrl) => set("tokenUrl", tokenUrl)}
                placeholder="https://api.example.com/oauth/token"
              />
              <FieldShell
                label="Client ID"
                mono
                value={draft.clientId}
                onValueChange={(clientId) => set("clientId", clientId)}
                autoComplete="off"
              />
              <FieldShell
                label="Client secret"
                type="password"
                mono
                value={draft.clientSecret}
                onValueChange={(clientSecret) =>
                  set("clientSecret", clientSecret)
                }
                autoComplete="off"
              />
              <FieldShell
                label="Scopes"
                mono
                value={draft.scopes}
                onValueChange={(scopes) => set("scopes", scopes)}
                placeholder="read write"
              />
              <FieldShell
                label="Refresh token"
                type="password"
                mono
                value={draft.refreshToken}
                onValueChange={(refreshToken) =>
                  set("refreshToken", refreshToken)
                }
                autoComplete="off"
              />
            </>
          ) : null}
          {draft.method === "basic" ? (
            <>
              <FieldShell
                label="Base URL"
                type="url"
                mono
                value={draft.baseUrl}
                onValueChange={(baseUrl) => set("baseUrl", baseUrl)}
                placeholder="https://api.example.com"
              />
              <FieldShell
                label="Username"
                mono
                value={draft.username}
                onValueChange={(username) => set("username", username)}
                autoComplete="off"
              />
              <FieldShell
                label="Password"
                type="password"
                mono
                value={draft.password}
                onValueChange={(password) => set("password", password)}
                autoComplete="off"
              />
            </>
          ) : null}
          {draft.method === "api-key" ? (
            <>
              <FieldShell
                label="Base URL"
                type="url"
                mono
                value={draft.baseUrl}
                onValueChange={(baseUrl) => set("baseUrl", baseUrl)}
                placeholder="https://api.example.com"
              />
              <FieldShell
                label="API header"
                mono
                value={draft.header}
                onValueChange={(header) => set("header", header)}
                placeholder="X-Api-Key"
              />
              <FieldShell
                label="API key value"
                type="password"
                mono
                value={draft.apiKey}
                onValueChange={(apiKey) => set("apiKey", apiKey)}
                autoComplete="off"
              />
            </>
          ) : null}
          {draft.method === "saml" ? (
            <>
              <FieldShell
                label="Base URL"
                type="url"
                mono
                value={draft.baseUrl}
                onValueChange={(baseUrl) => set("baseUrl", baseUrl)}
                placeholder="https://api.example.com"
              />
              <FieldShell
                label="SAML entity ID"
                mono
                value={draft.samlEntityId}
                onValueChange={(samlEntityId) =>
                  set("samlEntityId", samlEntityId)
                }
                autoComplete="off"
              />
              <FieldShell
                label="SAML metadata URL"
                type="url"
                mono
                value={draft.samlMetadataUrl}
                onValueChange={(samlMetadataUrl) =>
                  set("samlMetadataUrl", samlMetadataUrl)
                }
                placeholder="https://idp.example.com/metadata"
              />
              <div className="field">
                <label htmlFor="byo-saml-metadata-xml">SAML metadata XML</label>
                <textarea
                  id="byo-saml-metadata-xml"
                  className="f__input"
                  rows={5}
                  spellCheck={false}
                  value={draft.samlMetadataXml}
                  onChange={(event) =>
                    set("samlMetadataXml", event.target.value)
                  }
                />
              </div>
              <FieldShell
                label="SAML private key"
                type="password"
                mono
                value={draft.samlPrivateKey}
                onValueChange={(samlPrivateKey) =>
                  set("samlPrivateKey", samlPrivateKey)
                }
                autoComplete="off"
              />
            </>
          ) : null}
        </fieldset>
        <FailureNotice
          id="connections:byo"
          title="New connection"
          message={error}
        />
        <FormCommit
          label="Save connection"
          icon={<IconPlus size={18} />}
          busy={busy}
          disabled={busy || problems.length > 0}
        >
          {problems[0] ? <StatusMark tone="warn" label={problems[0]} /> : null}
        </FormCommit>
      </form>
    </section>
  );
}
