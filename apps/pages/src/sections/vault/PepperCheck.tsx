import type { PasswordMethod } from "@opensesame/vault-core";
import { useState } from "react";
import { StatusMark } from "../../components/StatusMark.js";
import { setPepper, setPepperAt } from "./account-secrets.js";

/**
 * *Include pepper* (ADR 0174). The password this method produces is then
 * incomplete on purpose: the person adds a secret of their own where they use
 * it, and the product is never asked for it and never keeps it. Turning it on
 * draws one more field, where the pepper goes, written like a Python index (end,
 * `3`, `-2`, `2:5`); it is absent until it is wanted.
 */
export function PepperCheck({
  method,
  onEdit,
}: {
  method: PasswordMethod;
  onEdit: (next: PasswordMethod) => void;
}) {
  const [text, setText] = useState(method.pepperAt ?? "");
  const [invalid, setInvalid] = useState(false);
  return (
    <>
      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            checked={method.pepper}
            onChange={(event) => {
              setInvalid(false);
              onEdit(setPepper(method, event.target.checked));
            }}
          />
          <span>Include pepper</span>
        </label>
      </div>
      {method.pepper ? (
        <div className="field">
          <label htmlFor={`${method.id}-pepper-at`}>Pepper goes</label>
          <div className="editor__inline">
            <input
              id={`${method.id}-pepper-at`}
              autoComplete="off"
              spellCheck={false}
              placeholder="end"
              title="Where your pepper goes, like a Python index: end, 0 for the start, -2 for before the last two characters, 2:5 to replace characters 3 to 5"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                const next = setPepperAt(method, event.target.value);
                setInvalid(next === null);
                if (next !== null) onEdit(next);
              }}
            />
            {invalid ? (
              <StatusMark
                tone="err"
                label="Not a position: try end, 3, -2 or 2:5"
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
