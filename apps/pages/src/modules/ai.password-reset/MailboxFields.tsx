import {
  MAIL_PROTOCOLS,
  MAIL_SECURITIES,
  type MailboxDraft,
  type MailboxServer,
} from "@opensesame/app-core/lib/password-reset/mailbox-store.js";
import { useId } from "react";

function TextField({
  id,
  label,
  value,
  onChange,
  type,
  invalid,
  placeholder,
  plain = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  type?: "email" | "password";
  invalid?: boolean;
  placeholder?: string;
  /** A host or a login: no capital letters, no spell check. */
  plain?: boolean;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        autoComplete={type === "password" ? "new-password" : "off"}
        autoCapitalize={plain ? "none" : undefined}
        spellCheck={plain ? false : undefined}
        aria-invalid={invalid}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function ChoiceField<T extends string>({
  id,
  label,
  value,
  choices,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  choices: readonly T[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        onChange={(event) => {
          const next = choices.find((choice) => choice === event.target.value);
          if (next) onChange(next);
        }}
      >
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice.toUpperCase()}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The server a mailbox's mail is read from, and the login for it. */
function ServerFields({
  id,
  server,
  invalidPort,
  savedPassword,
  onChange,
}: {
  id: string;
  server: MailboxServer;
  invalidPort: boolean;
  savedPassword: boolean;
  onChange: (patch: Partial<MailboxServer>) => void;
}) {
  return (
    <>
      <TextField
        id={`${id}-host`}
        label="Mail server"
        plain
        value={server.host}
        onChange={(host) => onChange({ host })}
      />
      <TextField
        id={`${id}-port`}
        label="Port"
        invalid={invalidPort}
        value={server.port}
        onChange={(port) => onChange({ port })}
      />
      <ChoiceField
        id={`${id}-protocol`}
        label="Protocol"
        value={server.protocol}
        choices={MAIL_PROTOCOLS}
        onChange={(protocol) => onChange({ protocol })}
      />
      <ChoiceField
        id={`${id}-security`}
        label="Security"
        value={server.security}
        choices={MAIL_SECURITIES}
        onChange={(security) => onChange({ security })}
      />
      <TextField
        id={`${id}-username`}
        label="Username"
        plain
        value={server.username}
        onChange={(username) => onChange({ username })}
      />
      <TextField
        id={`${id}-password`}
        label="Password"
        type="password"
        placeholder={savedPassword ? "••••••••" : undefined}
        value={server.password}
        onChange={(password) => onChange({ password })}
      />
    </>
  );
}

/**
 * The fields of one mailbox. The address is all it needs; the server and the
 * login are the advanced part that lets the app read its mail, and are drawn
 * only when asked for. The password is a concealed input and is never filled
 * in from the item: blank keeps the one the item holds.
 */
export function MailboxFields({
  draft,
  advanced,
  invalid,
  savedPassword,
  onChange,
}: {
  draft: MailboxDraft;
  advanced: boolean;
  invalid: "address" | "port" | null;
  /** The mailbox already holds a password: a blank one here keeps it. */
  savedPassword: boolean;
  onChange: (next: MailboxDraft) => void;
}) {
  const id = useId();
  return (
    <div className="editor__grid">
      <TextField
        id={`${id}-address`}
        label="Reset email"
        type="email"
        invalid={invalid === "address"}
        value={draft.address}
        onChange={(address) => onChange({ ...draft, address })}
      />
      {advanced ? (
        <>
          <TextField
            id={`${id}-name`}
            label="Name"
            value={draft.name}
            onChange={(name) => onChange({ ...draft, name })}
          />
          <ServerFields
            id={id}
            server={draft.server}
            invalidPort={invalid === "port"}
            savedPassword={savedPassword}
            onChange={(patch) =>
              onChange({ ...draft, server: { ...draft.server, ...patch } })
            }
          />
        </>
      ) : null}
    </div>
  );
}
