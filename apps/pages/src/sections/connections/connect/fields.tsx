import type {
  ConnectMethodKind,
  ConnectPlan,
} from "@opensesame/app-core/lib/connect-plan.js";
import { type ReactNode, useId } from "react";
import { IconCopy, IconExternal } from "../../../components/Icons.js";

/** A connection method is a choice object, so it keeps its word. */
export const METHOD_LABEL = {
  managed: "Vercel app",
  oauth: "OAuth",
  mcp: "MCP server",
  "api-key": "API key",
} satisfies Record<ConnectMethodKind, string>;

export function MethodPicker({
  plan,
  method,
  onMethod,
}: {
  plan: ConnectPlan;
  method: ConnectMethodKind;
  onMethod: (next: ConnectMethodKind) => void;
}) {
  const name = useId();
  if (plan.methods.length < 2) return null;
  return (
    <fieldset className="cx-block">
      <legend>Connection method</legend>
      <div className="conn-git-auth__modes" role="radiogroup">
        {plan.methods.map((item) => (
          <label key={item.kind} className="conn-git-auth__mode">
            <input
              type="radio"
              name={name}
              value={item.kind}
              checked={method === item.kind}
              onChange={() => onMethod(item.kind)}
            />
            <span>{METHOD_LABEL[item.kind]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (next: T) => void;
}) {
  const id = useId();
  return (
    <div className="cx-select">
      <label className="f__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => {
          const next = options.find((row) => row.id === event.target.value);
          if (next) onChange(next.id);
        }}
      >
        {options.map((row) => (
          <option key={row.id} value={row.id}>
            {row.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Label/value rows for things the page knows, never inputs. */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="cx-facts">
      {rows.map(([label, value]) => (
        <div key={label} className="cx-fact">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CopyKey({ value, label }: { value: string; label: string }) {
  return (
    <button
      type="button"
      className="icon-btn icon-btn--sm"
      aria-label={label}
      title={label}
      onClick={() => void navigator.clipboard?.writeText(value)}
    >
      <IconCopy size={14} />
    </button>
  );
}

/** A navigation target: where the provider issues a client or a key. */
export function OutLink({
  href,
  children,
}: { href: string; children: ReactNode }) {
  return (
    <a
      className="conn-doc-link"
      href={href}
      target="_blank"
      rel="noreferrer noopener"
    >
      {children} <IconExternal size={12} />
    </a>
  );
}
