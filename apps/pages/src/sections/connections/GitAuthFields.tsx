import type { GitAuthMode } from "../../lib/git-auth-modes.js";
import { GIT_AUTH_MODES, isGitAuthMode } from "../../lib/git-auth-modes.js";

export function GitAuthModePicker({
  authMode,
  onAuthMode,
}: {
  authMode: GitAuthMode;
  onAuthMode: (mode: GitAuthMode) => void;
}) {
  return (
    <fieldset className="conn-git-auth">
      <legend className="label">Authentication</legend>
      <div className="conn-git-auth__modes" role="radiogroup">
        {GIT_AUTH_MODES.map((mode) => (
          <label key={mode.id} className="conn-git-auth__mode">
            <input
              type="radio"
              name="auth_mode"
              value={mode.id}
              checked={authMode === mode.id}
              onChange={(event) => {
                if (isGitAuthMode(event.target.value)) {
                  onAuthMode(event.target.value);
                }
              }}
            />
            <span>{mode.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function GitHttpsCredentialFields({
  nameId,
  authMode,
  username,
  token,
  password,
  onUsername,
  onToken,
  onPassword,
}: {
  nameId: string;
  authMode: Extract<GitAuthMode, "https_token" | "https_basic">;
  username: string;
  token: string;
  password: string;
  onUsername: (value: string) => void;
  onToken: (value: string) => void;
  onPassword: (value: string) => void;
}) {
  return (
    <>
      <div className="field">
        <label className="label" htmlFor={`${nameId}-user`}>
          Username
          {authMode === "https_token" ? " (optional)" : ""}
        </label>
        <input
          id={`${nameId}-user`}
          name="username"
          autoComplete="off"
          spellCheck={false}
          required={authMode === "https_basic"}
          placeholder={
            authMode === "https_token" ? "git / oauth2 / x-access-token" : ""
          }
          value={username}
          onChange={(event) => onUsername(event.target.value)}
        />
      </div>
      {authMode === "https_token" ? (
        <div className="field">
          <label className="label" htmlFor={`${nameId}-token`}>
            Token
          </label>
          <input
            id={`${nameId}-token`}
            name="token"
            type="password"
            autoComplete="off"
            required
            value={token}
            onChange={(event) => onToken(event.target.value)}
          />
        </div>
      ) : (
        <div className="field">
          <label className="label" htmlFor={`${nameId}-password`}>
            Password
          </label>
          <input
            id={`${nameId}-password`}
            name="password"
            type="password"
            autoComplete="off"
            required
            value={password}
            onChange={(event) => onPassword(event.target.value)}
          />
        </div>
      )}
    </>
  );
}

export function GitSshKeyFields({
  nameId,
  sshKey,
  sshPassphrase,
  onSshKey,
  onSshPassphrase,
}: {
  nameId: string;
  sshKey: string;
  sshPassphrase: string;
  onSshKey: (value: string) => void;
  onSshPassphrase: (value: string) => void;
}) {
  return (
    <>
      <div className="field">
        <label className="label" htmlFor={`${nameId}-ssh-key`}>
          SSH private key
        </label>
        <textarea
          id={`${nameId}-ssh-key`}
          name="ssh_private_key"
          required
          rows={4}
          spellCheck={false}
          autoComplete="off"
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
          value={sshKey}
          onChange={(event) => onSshKey(event.target.value)}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${nameId}-ssh-pass`}>
          Passphrase (optional)
        </label>
        <input
          id={`${nameId}-ssh-pass`}
          name="ssh_passphrase"
          type="password"
          autoComplete="off"
          value={sshPassphrase}
          onChange={(event) => onSshPassphrase(event.target.value)}
        />
      </div>
    </>
  );
}
