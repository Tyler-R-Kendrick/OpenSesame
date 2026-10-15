import type {
  IdentityConnectionCredentials,
  IdentityConnectionDraft,
} from "@opensesame/app-core/lib/identity-connections-schema.js";
import { type FormEvent, useLayoutEffect, useRef, useState } from "react";
import { keyboardIsIdle, landFocus } from "../lib/focus.js";
import { FieldShell } from "./FieldShell.js";
import { FormCommit } from "./FormCommit.js";
import { IconLogin } from "./Icons.js";
import { StatusMark } from "./StatusMark.js";

export function IdentityConnectionSignIn({
  draft,
  busy,
  online,
  onSignIn,
  failure,
  autoFocus = false,
  className = "unlock__form",
}: {
  draft: IdentityConnectionDraft;
  busy: boolean;
  online: boolean;
  failure?: string;
  autoFocus?: boolean;
  className?: string;
  onSignIn: (credentials?: IdentityConnectionCredentials) => Promise<void>;
}) {
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const native =
    draft.protocol === "better-auth" || draft.protocol === "supabase";
  useLayoutEffect(() => {
    if (autoFocus && keyboardIsIdle()) landFocus(emailRef.current);
  }, [autoFocus]);
  useLayoutEffect(() => {
    if (failure && !busy && keyboardIsIdle()) landFocus(passwordRef.current);
  }, [failure, busy]);
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const credentials = native ? { email: email.trim(), password } : undefined;
    setPassword("");
    await onSignIn(credentials);
  }
  return (
    <form className={className} onSubmit={(event) => void signIn(event)}>
      {native ? (
        <>
          <FieldShell
            inputRef={emailRef}
            label="Email address"
            type="email"
            autoComplete="username"
            value={email}
            disabled={busy}
            onValueChange={setEmail}
          />
          <FieldShell
            inputRef={passwordRef}
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            disabled={busy}
            onValueChange={setPassword}
          />
        </>
      ) : null}
      <FormCommit
        label={`Sign in to ${draft.name}`}
        icon={<IconLogin size={18} />}
        disabled={busy || !online || (native && (!email.trim() || !password))}
        busy={busy}
      >
        {failure ? <StatusMark tone="err" label={failure} /> : null}
      </FormCommit>
    </form>
  );
}
