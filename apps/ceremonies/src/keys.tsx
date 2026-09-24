import type { ButtonHTMLAttributes, ReactNode, SVGProps } from "react";
import "./keys.css";

/**
 * The ceremony pages' keys (DESIGN.md § Actions are symbols): an action that
 * executes is a square with its sentence in `aria-label` and `title`, and the
 * action that ends a ceremony is the `.go` square with its verb beside it —
 * the same objects Pages draws, without Pages' bundle.
 */

type IconProps = { size?: number };

function Svg({
  size = 16,
  children,
  ...rest
}: IconProps & { children: ReactNode } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Svg>
  );
}

export function IconX(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

export function IconCopy(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 5.5V5A1.5 1.5 0 0 0 14 3.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h.5" />
    </Svg>
  );
}

export function IconAlert(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4.5l8.5 15h-17z" />
      <path d="M12 10v4M12 17h.01" />
    </Svg>
  );
}

export function IconUp(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.5 14.5L12 9l5.5 5.5" />
    </Svg>
  );
}

export function IconDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.5 9.5L12 15l5.5-5.5" />
    </Svg>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M19 12a7 7 0 1 1-2.05-4.95M19 4.5V9h-4.5" />
    </Svg>
  );
}

export function IconDownload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4.5v10M7.5 10l4.5 4.5 4.5-4.5M5 19.5h14" />
    </Svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

/** An icon key: the square, its sentence as its name and its tooltip. */
export function Key({
  label,
  children,
  danger = false,
  ...rest
}: {
  label: string;
  children: ReactNode;
  danger?: boolean;
} & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label" | "title" | "className"
>) {
  return (
    <button
      type="button"
      {...rest}
      className={danger ? "icon-btn icon-btn--danger" : "icon-btn"}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

/**
 * The action that ends a ceremony: the `.go` square, and its verb beside it
 * in the margin voice. `children` are the ceremony's other keys (deny, keep),
 * which ride the same row.
 */
export function Commit({
  label,
  icon,
  disabled,
  busy,
  onClick,
  children,
}: {
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  busy?: boolean;
  /** Omitted: the square submits its form. */
  onClick?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="go-row">
      <button
        type={onClick ? "button" : "submit"}
        className="go"
        disabled={disabled}
        aria-busy={busy || undefined}
        aria-label={label}
        title={label}
        onClick={onClick}
      >
        {icon ?? <IconCheck size={18} />}
      </button>
      <span className="go-verb" aria-hidden="true">
        {label}
      </span>
      {children}
    </div>
  );
}
