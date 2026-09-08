import type { FormEvent } from "react";

/** The masked value goes up once and the parent clears it on submit, success
 * or failure. All returned data remains metadata, never a secret value. */

export function SecretConfigSetForm({
  busy,
  newKeyName,
  newKeyValue,
  setNewKeyName,
  setNewKeyValue,
  onSetSecret,
}: {
  busy: boolean;
  newKeyName: string;
  newKeyValue: string;
  setNewKeyName: (value: string) => void;
  setNewKeyValue: (value: string) => void;
  onSetSecret: (event: FormEvent) => Promise<void>;
}) {
  return (
    <form className="set__inline" onSubmit={(event) => void onSetSecret(event)}>
      <div className="field set__inline-grow">
        <label htmlFor="secret-config-key">Key name</label>
        <input
          id="secret-config-key"
          value={newKeyName}
          placeholder="DATABASE_URL"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setNewKeyName(event.target.value)}
        />
      </div>
      <div className="field set__inline-grow">
        <label htmlFor="secret-config-value">Value (write-only)</label>
        <input
          id="secret-config-value"
          type="password"
          value={newKeyValue}
          autoComplete="off"
          onChange={(event) => setNewKeyValue(event.target.value)}
        />
      </div>
      <button
        type="submit"
        className="btn btn--primary"
        disabled={busy || !newKeyName.trim() || !newKeyValue}
      >
        Set secret
      </button>
    </form>
  );
}

export function SecretConfigBranchForm({
  busy,
  branchSlug,
  setBranchSlug,
  onBranch,
}: {
  busy: boolean;
  branchSlug: string;
  setBranchSlug: (value: string) => void;
  onBranch: (event: FormEvent) => Promise<void>;
}) {
  return (
    <form className="set__inline" onSubmit={(event) => void onBranch(event)}>
      <div className="field set__inline-grow">
        <label htmlFor="secret-config-branch">Branch into child config</label>
        <input
          id="secret-config-branch"
          value={branchSlug}
          placeholder="dev-yourname"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setBranchSlug(event.target.value)}
        />
      </div>
      <button
        type="submit"
        className="btn"
        disabled={busy || !branchSlug.trim()}
      >
        Branch
      </button>
    </form>
  );
}
