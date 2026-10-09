import type { ReactNode } from "react";

function options(rows: readonly { id: string | number; label: string }[]) {
  return rows.map((row) => (
    <option key={String(row.id)} value={row.id}>
      {row.label}
    </option>
  ));
}

export function ShareGrantSelectField({
  id,
  label,
  required,
  busy,
  value,
  onChange,
  options: rows,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  busy: boolean;
  value: string | number;
  onChange: (value: string) => void;
  options?: readonly { id: string | number; label: string }[];
  children?: ReactNode;
}) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        required={required}
        disabled={busy}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children ?? options(rows ?? [])}
      </select>
    </div>
  );
}
