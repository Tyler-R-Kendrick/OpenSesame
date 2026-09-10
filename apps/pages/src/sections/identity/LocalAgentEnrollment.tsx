import type { BoundaryValue } from "@opensesame/os-domain";
import { useEffect, useId, useRef, useState } from "react";

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
        <p role="alert" className="note note--err">
          {error}
        </p>
      ) : null}
      <div className="actions">
        <button
          type="submit"
          className="btn btn--primary"
          disabled={disabled || !draft.trim()}
        >
          Save public key
        </button>
        <button
          type="button"
          className="btn"
          disabled={disabled}
          onClick={close}
        >
          Cancel enrollment
        </button>
      </div>
    </form>
  );
}
