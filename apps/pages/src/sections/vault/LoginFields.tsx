import type { LoginItem } from "@opensesame/vault-core";
import type { Dispatch, SetStateAction } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconEye, IconEyeOff, IconRefresh } from "../../components/Icons.js";
import { PasswordGenerator } from "../../components/PasswordGenerator.js";
import { OptionalField } from "./EditorExtras.js";
import { LoginWebsites } from "./LoginWebsites.js";
import { ResetEmailField } from "./ResetEmailField.js";

/** The login editor's own fields, including the reset mailbox when it applies. */
export function LoginFields({
  draft,
  reveal,
  showGenerator,
  onPatch,
  onReveal,
  onShowGenerator,
}: {
  draft: LoginItem;
  reveal: boolean;
  showGenerator: boolean;
  onPatch: (changes: Partial<LoginItem>) => void;
  onReveal: Dispatch<SetStateAction<boolean>>;
  onShowGenerator: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <div className="editor__grid">
      <LoginWebsites uris={draft.uris} onChange={(uris) => onPatch({ uris })} />
      <div className="field">
        <label htmlFor="username">Username</label>
        <input
          id="username"
          autoComplete="off"
          value={draft.username}
          onChange={(event) => onPatch({ username: event.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <div className="editor__inline editor__inline--adorned">
          <input
            id="password"
            type={reveal ? "text" : "password"}
            autoComplete="new-password"
            value={draft.password}
            onChange={(event) => onPatch({ password: event.target.value })}
          />
          <IconKey
            label={reveal ? "Hide password" : "Show password"}
            onClick={() => onReveal((value) => !value)}
          >
            {reveal ? <IconEyeOff size={17} /> : <IconEye size={17} />}
          </IconKey>
          <button
            type="button"
            className={`icon-btn${showGenerator ? " is-on" : ""}`}
            onClick={() => onShowGenerator((value) => !value)}
            aria-expanded={showGenerator}
            aria-label="Password generator"
            title="Password generator"
          >
            <IconRefresh size={17} />
          </button>
        </div>
      </div>
      {showGenerator ? (
        <PasswordGenerator
          onUse={(value) => {
            onPatch({ password: value });
            onShowGenerator(false);
            onReveal(true);
          }}
          onDismiss={() => onShowGenerator(false)}
        />
      ) : null}
      <OptionalField
        key={draft.id}
        present={Boolean(draft.totp)}
        command="Add authenticator secret"
      >
        <div className="field">
          <label htmlFor="totp">Authenticator secret</label>
          <input
            id="totp"
            autoComplete="off"
            spellCheck={false}
            placeholder="Base32 seed or otpauth:// URI"
            value={draft.totp}
            onChange={(event) => onPatch({ totp: event.target.value })}
          />
        </div>
      </OptionalField>
      <ResetEmailField
        emailId={draft.resetEmailId}
        onChange={(resetEmailId) => onPatch({ resetEmailId })}
      />
    </div>
  );
}
