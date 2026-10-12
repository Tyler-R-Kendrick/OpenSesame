import type { OAuthClient } from "@opensesame/app-core/lib/directory.js";
import {
  previewHostedClaims,
  updateApplication,
} from "@opensesame/app-core/lib/oauth-client-admin.js";
import { useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import { IconEye, IconX } from "../../components/Icons.js";

type HostedDraftSave = {
  displayName: string;
  redirectUris: string[];
  grantTypes?: string[];
  tokenEndpointAuthMethod?: string;
};

async function saveHostedDraft(clientId: string, draft: HostedDraftSave) {
  await updateApplication(clientId, draft.displayName, draft.redirectUris, {
    ...(draft.grantTypes ? { grantTypes: draft.grantTypes } : undefined),
    ...(draft.tokenEndpointAuthMethod
      ? { tokenEndpointAuthMethod: draft.tokenEndpointAuthMethod }
      : undefined),
  });
}

function ApplicationFields(props: {
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
  const [name, setName] = useState(client.displayName);
  const [redirects, setRedirects] = useState(client.redirectUris.join("\n"));
  const [workload, setWorkload] = useState(
    (client.grantTypes ?? []).includes("client_credentials"),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState("");

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
    const draft = {
      displayName: name.trim(),
      redirectUris: redirects
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      grantTypes: workload
        ? ["authorization_code", "client_credentials"]
        : ["authorization_code"],
      tokenEndpointAuthMethod: workload ? "private_key_jwt" : "none",
    };
    void run(() => saveHostedDraft(client.id, draft));
  }

  return (
    <HostedApplicationForm
      client={client}
      online={online}
      name={name}
      redirects={redirects}
      workload={workload}
      busy={busy}
      error={error}
      preview={preview}
      onName={setName}
      onRedirects={setRedirects}
      onWorkload={setWorkload}
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
  name: string;
  redirects: string;
  workload: boolean;
  busy: boolean;
  error: string;
  preview: string;
  onName: (value: string) => void;
  onRedirects: (value: string) => void;
  onWorkload: (value: boolean) => void;
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
      <ApplicationFields
        name={props.name}
        redirects={props.redirects}
        workload={props.workload}
        busy={props.busy}
        onName={props.onName}
        onRedirects={props.onRedirects}
        onWorkload={props.onWorkload}
      />
      <FailureNotice
        id={`identity:application:${props.client.id}`}
        title="Application"
        message={props.error}
      />
      {props.preview ? (
        <pre className="cfg-pre" aria-label="Claim preview">
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
  name: string;
  redirects: string;
  busy: boolean;
  onPreview: (value: string) => void;
  onError: (value: string) => void;
  onCancel: () => void;
}) {
  const ready = Boolean(props.name.trim() && props.redirects.trim());
  return (
    <FormCommit
      label="Save application"
      disabled={props.busy || !props.online || !ready}
    >
      <IconKey
        label="Preview claims"
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
        <IconEye size={16} />
      </IconKey>
      <button
        type="button"
        className="icon-btn"
        disabled={props.busy}
        onClick={props.onCancel}
        aria-label="Cancel"
        title="Cancel"
      >
        <IconX size={16} />
      </button>
    </FormCommit>
  );
}
