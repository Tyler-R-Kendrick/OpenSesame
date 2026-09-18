import { useState } from "react";
import { ModeToggle } from "../../components/configuration/ModeToggle.js";
import { SourceEditor } from "../../components/configuration/SourceEditor.js";
import type { EditorMode } from "../../lib/configuration/draft.js";
import {
  hostedClientToYaml,
  parseHostedApplicationSource,
} from "../../lib/configuration/hosted-application.js";
import type { OAuthClient } from "../../lib/directory.js";
import {
  previewHostedClaims,
  updateApplication,
} from "../../lib/identity-management.js";

async function saveHostedDraft(
  clientId: string,
  draft: {
    displayName: string;
    redirectUris: string[];
    grantTypes?: string[];
    tokenEndpointAuthMethod?: string;
  },
) {
  await updateApplication(clientId, draft.displayName, draft.redirectUris, {
    ...(draft.grantTypes ? { grantTypes: draft.grantTypes } : undefined),
    ...(draft.tokenEndpointAuthMethod
      ? { tokenEndpointAuthMethod: draft.tokenEndpointAuthMethod }
      : undefined),
  });
}

function VisualApplicationFields(props: {
  name: string;
  redirects: string;
  workload: boolean;
  busy: boolean;
  onName: (value: string) => void;
  onRedirects: (value: string) => void;
  onWorkload: (value: boolean) => void;
}) {
  return (
    <>
      <div className="field">
        <label className="label" htmlFor="identity-app-name">
          Application name
        </label>
        <input
          id="identity-app-name"
          required
          maxLength={128}
          value={props.name}
          disabled={props.busy}
          onChange={(event) => props.onName(event.target.value)}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="identity-app-redirects">
          Redirect URIs (one per line)
        </label>
        <textarea
          id="identity-app-redirects"
          required
          value={props.redirects}
          disabled={props.busy}
          onChange={(event) => props.onRedirects(event.target.value)}
        />
      </div>
      <label className="field">
        <input
          type="checkbox"
          checked={props.workload}
          disabled={props.busy}
          onChange={(event) => props.onWorkload(event.target.checked)}
        />{" "}
        Workload client_credentials (confidential, private_key_jwt)
      </label>
    </>
  );
}

export function EditApplication({
  client,
  online,
  onSaved,
  onCancel,
}: {
  client: OAuthClient;
  online: boolean;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<EditorMode>("visual");
  const [name, setName] = useState(client.displayName);
  const [redirects, setRedirects] = useState(client.redirectUris.join("\n"));
  const [workload, setWorkload] = useState(
    (client.grantTypes ?? []).includes("client_credentials"),
  );
  const [source, setSource] = useState(hostedClientToYaml(client));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState("");
  const parsed = parseHostedApplicationSource(source, client.id);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await task();
      onSaved();
    } catch {
      setError(
        "Could not save the application; check ownership and exact redirect URLs.",
      );
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    if (mode === "source") {
      if (!parsed.ok) {
        setError(parsed.diagnostics[0]?.message ?? "Invalid source.");
        return;
      }
      void run(() => saveHostedDraft(client.id, parsed.value));
      return;
    }
    void run(() =>
      saveHostedDraft(client.id, {
        displayName: name.trim(),
        redirectUris: redirects
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        grantTypes: workload
          ? ["authorization_code", "client_credentials"]
          : ["authorization_code"],
        tokenEndpointAuthMethod: workload ? "private_key_jwt" : "none",
      }),
    );
  }

  return (
    <HostedApplicationForm
      client={client}
      online={online}
      mode={mode}
      name={name}
      redirects={redirects}
      workload={workload}
      source={source}
      busy={busy}
      error={error}
      preview={preview}
      parsed={parsed}
      onMode={setMode}
      onName={setName}
      onRedirects={setRedirects}
      onWorkload={setWorkload}
      onSource={setSource}
      onPreview={setPreview}
      onError={setError}
      onCancel={onCancel}
      onSubmit={submit}
    />
  );
}

function HostedApplicationForm(props: {
  client: OAuthClient;
  online: boolean;
  mode: EditorMode;
  name: string;
  redirects: string;
  workload: boolean;
  source: string;
  busy: boolean;
  error: string;
  preview: string;
  parsed: ReturnType<typeof parseHostedApplicationSource>;
  onMode: (mode: EditorMode) => void;
  onName: (value: string) => void;
  onRedirects: (value: string) => void;
  onWorkload: (value: boolean) => void;
  onSource: (value: string) => void;
  onPreview: (value: string) => void;
  onError: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <h3>Edit application</h3>
      <ModeToggle mode={props.mode} onMode={props.onMode} />
      <p className="hint">
        This is a hosted OIDC client on the Identity API. Registration is not
        consent. Pages is not a SAML IdP or LDAP server.
      </p>
      {props.mode === "visual" ? (
        <VisualApplicationFields
          name={props.name}
          redirects={props.redirects}
          workload={props.workload}
          busy={props.busy}
          onName={props.onName}
          onRedirects={props.onRedirects}
          onWorkload={props.onWorkload}
        />
      ) : (
        <SourceEditor
          id={`hosted-app-source-${props.client.id}`}
          value={props.source}
          diagnostics={props.parsed.ok ? [] : props.parsed.diagnostics}
          onChange={props.onSource}
          disabled={props.busy}
        />
      )}
      <p className="hint">
        Authorization code with PKCE S256; exact redirects remain enforced.
        Public clients cannot use client_credentials.
      </p>
      {props.error ? (
        <p className="note note--err" role="alert">
          {props.error}
        </p>
      ) : null}
      {props.preview ? (
        <pre className="cfg-source__input" aria-label="Claim preview">
          {props.preview}
        </pre>
      ) : null}
      <HostedApplicationActions {...props} />
    </form>
  );
}

function HostedApplicationActions(props: {
  client: OAuthClient;
  online: boolean;
  mode: EditorMode;
  name: string;
  redirects: string;
  busy: boolean;
  parsed: ReturnType<typeof parseHostedApplicationSource>;
  onPreview: (value: string) => void;
  onError: (value: string) => void;
  onCancel: () => void;
}) {
  const visualReady = Boolean(props.name.trim() && props.redirects.trim());
  return (
    <div className="actions">
      <button
        type="submit"
        className="btn btn--primary"
        disabled={
          props.busy ||
          !props.online ||
          (props.mode === "visual" ? !visualReady : !props.parsed.ok)
        }
      >
        {props.busy ? "Saving…" : "Save application"}
      </button>
      <button
        type="button"
        className="btn btn--sm"
        disabled={props.busy || !props.online}
        onClick={() => {
          void previewHostedClaims(props.client.id, {
            scopes: props.client.allowedScopes,
            persona: {
              name: "Ada",
              email: "ada@example.test",
              emailVerified: true,
              emailAuthoritative: true,
            },
          }).then(
            (body) => props.onPreview(JSON.stringify(body)),
            () =>
              props.onError(
                "Claim preview failed. Confirm you own this client.",
              ),
          );
        }}
      >
        Preview claims
      </button>
      <button
        type="button"
        className="btn"
        disabled={props.busy}
        onClick={props.onCancel}
      >
        Cancel
      </button>
    </div>
  );
}
