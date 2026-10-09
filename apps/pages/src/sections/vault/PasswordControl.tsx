import { FIELD_LIMITS } from "@opensesame/app-core/lib/vault/field-limits.js";
import type { PasswordMethod } from "@opensesame/vault-core";
import { useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import {
  IconEye,
  IconEyeOff,
  IconRefresh,
  IconSettings,
} from "../../components/Icons.js";
import {
  holdValue,
  regenerate,
  rotate,
  shownPassword,
} from "./account-secrets.js";

const GENERATED = new Set(["rules", "passphrase", "derived"]);

/**
 * The password itself: typed, generated or computed, with its reveal,
 * regenerate and options keys inside its rule. An algorithmic password is computed from its root, and its
 * key rotates it. What is shown is what the product produces before the
 * person's own pepper, if the method includes one (ADR 0174). Typing over a
 * generated one is choosing to type it, so it becomes typed.
 */
export function PasswordControl({
  method,
  onEdit,
  options,
}: {
  method: PasswordMethod;
  onEdit: (next: PasswordMethod) => void;
  /** The key that opens the generator's options, and whether they are open. */
  options: { open: boolean; controls: string; onToggle: () => void };
}) {
  const [reveal, setReveal] = useState(false);
  const { generator } = method;
  return (
    <div className="editor__inline editor__inline--adorned">
      <input
        id={`${method.id}-password`}
        type={reveal ? "text" : "password"}
        autoComplete="new-password"
        spellCheck={false}
        maxLength={FIELD_LIMITS.secret}
        value={shownPassword(method)}
        onChange={(event) => onEdit(holdValue(method, event.target.value))}
      />
      <IconKey
        label={reveal ? "Hide password" : "Show password"}
        aria-pressed={reveal}
        onClick={() => setReveal((on) => !on)}
      >
        {reveal ? <IconEyeOff size={17} /> : <IconEye size={17} />}
      </IconKey>
      {GENERATED.has(generator.id) ? (
        <IconKey
          label="Generate another password"
          onClick={() => {
            const made =
              generator.id === "derived" ? rotate(method) : regenerate(method);
            if (made) {
              onEdit(made);
              setReveal(true);
            }
          }}
        >
          <IconRefresh size={17} />
        </IconKey>
      ) : null}
      <IconKey
        label="Password options"
        aria-expanded={options.open}
        aria-controls={options.controls}
        onClick={options.onToggle}
      >
        <IconSettings size={17} />
      </IconKey>
    </div>
  );
}
