import type { PasswordMethod } from "@opensesame/vault-core";
import { useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconEye, IconEyeOff, IconRefresh } from "../../components/Icons.js";
import {
  type MethodEdit,
  type PlainEntry,
  holdValue,
  regenerate,
} from "./account-secrets.js";

/**
 * The password itself: typed or generated, with its reveal and regenerate
 * keys. A sealed password the editor does not hold has nothing to show, so no
 * eye; typing over a generated one is choosing to type it, so it becomes Manual.
 */
export function PasswordFieldRow({
  method,
  entry,
  onEdit,
}: {
  method: PasswordMethod;
  entry: PlainEntry | undefined;
  onEdit: (edit: MethodEdit) => void;
}) {
  const [reveal, setReveal] = useState(false);
  const { generator } = method;
  const value = method.pepper ? (entry?.value ?? "") : method.secret;
  const sealedUnknown = method.pepper && entry === undefined;
  const generated = generator.id === "rules" || generator.id === "passphrase";
  return (
    <div className="field">
      <label htmlFor={`${method.id}-password`}>Password</label>
      <div className="editor__inline editor__inline--adorned">
        <input
          id={`${method.id}-password`}
          type={reveal && !sealedUnknown ? "text" : "password"}
          autoComplete="new-password"
          spellCheck={false}
          placeholder={sealedUnknown && method.sealed ? "••••••••" : undefined}
          value={value}
          onChange={(event) => {
            const manual =
              generator.id === "manual"
                ? method
                : { ...method, generator: { id: "manual" } as const };
            onEdit(holdValue(manual, event.target.value));
          }}
        />
        {sealedUnknown ? null : (
          <IconKey
            label={reveal ? "Hide password" : "Show password"}
            aria-pressed={reveal}
            onClick={() => setReveal((on) => !on)}
          >
            {reveal ? <IconEyeOff size={17} /> : <IconEye size={17} />}
          </IconKey>
        )}
        {generated ? (
          <IconKey
            label="Generate another password"
            onClick={() => {
              const made = regenerate(method);
              if (made) {
                onEdit(made);
                setReveal(true);
              }
            }}
          >
            <IconRefresh size={17} />
          </IconKey>
        ) : null}
      </div>
    </div>
  );
}
