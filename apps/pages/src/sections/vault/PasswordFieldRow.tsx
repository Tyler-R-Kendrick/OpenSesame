import { type PasswordMethod, deriveCharacters } from "@opensesame/vault-core";
import { useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconEye, IconEyeOff, IconRefresh } from "../../components/Icons.js";
import {
  type MethodEdit,
  type PlainEntry,
  holdValue,
  regenerate,
  rotate,
} from "./account-secrets.js";

const GENERATED = new Set(["rules", "passphrase", "derived"]);

/** What the field shows: the password, or the one a derived root computes. */
function shown(method: PasswordMethod, entry: PlainEntry | undefined): string {
  const secret = method.pepper ? (entry?.value ?? "") : method.secret;
  const { generator } = method;
  return generator.id === "derived" && secret !== ""
    ? deriveCharacters(secret, generator.counter, generator.rules)
    : secret;
}

/** Typing over a generated password is choosing to type it. */
function typed(method: PasswordMethod, text: string): MethodEdit {
  const manual: PasswordMethod =
    method.generator.id === "manual"
      ? method
      : { ...method, generator: { id: "manual" } };
  return holdValue(manual, text);
}

/**
 * The password itself: typed, generated or computed, with its reveal and
 * regenerate keys. A derived password is computed from its root, and its key
 * rotates it. A sealed password the editor does not hold has nothing to show,
 * so no eye; typing over a generated one is choosing to type it, so it becomes
 * Manual.
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
  const value = shown(method, entry);
  const sealedUnknown = method.pepper && entry === undefined;
  const generated = GENERATED.has(generator.id);
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
          onChange={(event) => onEdit(typed(method, event.target.value))}
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
              const made =
                generator.id === "derived"
                  ? rotate(method, entry)
                  : regenerate(method);
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
