import { useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconEye, IconEyeOff } from "../../components/Icons.js";

/** A concealed editor field with its reveal key, in the rule the other fields use. */
export function SecretInput({
  id,
  label,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const [reveal, setReveal] = useState(false);
  const name = label.toLowerCase();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="editor__inline editor__inline--adorned">
        <input
          id={id}
          type={reveal ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
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
    </div>
  );
}

export function TextInput({
  id,
  label,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
