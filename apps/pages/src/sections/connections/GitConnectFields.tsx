import type { GitAuthMode } from "@opensesame/app-core/lib/git-auth-modes.js";
import type { FormEvent } from "react";
import { IconCheck } from "../../components/Icons.js";
import {
  GitAuthModePicker,
  GitHttpsCredentialFields,
  GitSshKeyFields,
} from "./GitAuthFields.js";

export type GitConnectFieldsModel = {
  nameId: string;
  name: string;
  remoteUrl: string;
  authMode: GitAuthMode;
  username: string;
  token: string;
  password: string;
  sshKey: string;
  sshPassphrase: string;
  busy: boolean;
  canSave: boolean;
  onName: (value: string) => void;
  onRemoteUrl: (value: string) => void;
  onAuthMode: (mode: GitAuthMode) => void;
  onUsername: (value: string) => void;
  onToken: (value: string) => void;
  onPassword: (value: string) => void;
  onSshKey: (value: string) => void;
  onSshPassphrase: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
};

export function GitConnectFields({ model }: { model: GitConnectFieldsModel }) {
  return (
    <form className="conn-tile__body" onSubmit={model.onSubmit}>
      <div className="field">
        <label className="label" htmlFor={`${model.nameId}-remote`}>
          Remote URL
        </label>
        <input
          id={`${model.nameId}-remote`}
          name="remote_url"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          required
          placeholder="https://…/repo.git or git@host:org/repo.git"
          value={model.remoteUrl}
          onChange={(event) => model.onRemoteUrl(event.target.value)}
        />
      </div>
      <GitAuthModePicker
        authMode={model.authMode}
        onAuthMode={model.onAuthMode}
      />
      {model.authMode === "https_token" || model.authMode === "https_basic" ? (
        <GitHttpsCredentialFields
          nameId={model.nameId}
          authMode={model.authMode}
          username={model.username}
          token={model.token}
          password={model.password}
          onUsername={model.onUsername}
          onToken={model.onToken}
          onPassword={model.onPassword}
        />
      ) : null}
      {model.authMode === "ssh_key" ? (
        <GitSshKeyFields
          nameId={model.nameId}
          sshKey={model.sshKey}
          sshPassphrase={model.sshPassphrase}
          onSshKey={model.onSshKey}
          onSshPassphrase={model.onSshPassphrase}
        />
      ) : null}
      <details className="conn-client-alt">
        <summary>Optional settings</summary>
        <div className="field">
          <label className="label" htmlFor={model.nameId}>
            Name it
          </label>
          <input
            id={model.nameId}
            value={model.name}
            onChange={(event) => model.onName(event.target.value)}
          />
        </div>
      </details>
      <div className="actions">
        <button
          type="submit"
          className="icon-btn icon-btn--sm"
          disabled={model.busy || !model.canSave}
          aria-label={model.busy ? "Saving" : "Save Git remote"}
          title={model.busy ? "Saving" : "Save Git remote"}
        >
          <IconCheck size={16} />
        </button>
      </div>
    </form>
  );
}
