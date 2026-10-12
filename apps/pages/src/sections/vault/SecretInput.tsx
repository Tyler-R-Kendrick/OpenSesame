import { FIELD_LIMITS } from "@opensesame/app-core/lib/vault/field-limits.js";
import { useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconEye, IconEyeOff } from "../../components/Icons.js";

/** A concealed field with its reveal key inside its rule, in the rule the other fields use. */
export function SecretControl({
  id,
  label,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  /** What the reveal key names: `Show <label>`. */
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const [reveal, setReveal] = useState(false);
  const name = label.toLowerCase();
  return (
    <div className="editor__inline editor__inline--adorned">
      <input
        id={id}
        type={reveal ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        maxLength={FIELD_LIMITS.secret}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <IconKey
        label={reveal ? `Hide ${name}` : `Show ${name}`}
        aria-pressed={reveal}
        onClick={() => setReveal((on) => !on)}
      >
        {reveal ? <IconEyeOff size={17} /> : <IconEye size={17} />}
      </IconKey>
    </div>
  );
}

/** A plain field, ruled like the rest. */
export function TextControl({
  id,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      id={id}
      autoComplete="off"
      spellCheck={false}
      maxLength={FIELD_LIMITS.line}
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
