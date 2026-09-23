import type { BoundaryValue } from "@opensesame/os-domain";
import { useEffect, useId, useRef, useState } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconCheck, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

export function LocalAgentEnrollment({
  disabled,
  save,
  close,
}: {
  disabled: boolean;
  save: (input: BoundaryValue) => Promise<boolean>;
  close: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const inputId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  async function submit() {
    try {
      const value: BoundaryValue = JSON.parse(draft);
      setError("");
      if (await save(value)) close();
    } catch {
      setError("Provide a public JWK as JSON. Do not include a private key.");
      input.current?.focus();
    }
  }
  return (
    <form
      aria-label="Enroll agent public key"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="field">
        <label className="label" htmlFor={inputId}>
          Public key JWK
        </label>
        <textarea
          ref={input}
          id={inputId}
          rows={5}
          maxLength={4096}
          required
          disabled={disabled}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      {error ? (
        <>
          <StatusMark tone="err" label={error} />
          <span role="alert" className="visually-hidden">
            {error}
          </span>
        </>
      ) : null}
      <FormCommit label="Save public key" disabled={disabled || !draft.trim()}>
        <button
          type="button"
          className="icon-btn"
          disabled={disabled}
          onClick={close}
          aria-label="Cancel enrollment"
          title="Cancel enrollment"
        >
          <IconX size={16} />
        </button>
      </FormCommit>
    </form>
  );
}
