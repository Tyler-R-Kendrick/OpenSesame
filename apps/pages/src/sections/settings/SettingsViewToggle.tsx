import type { RawFormat } from "./settings-files.js";

const VIEWS: ReadonlyArray<{
  id: "form" | RawFormat;
  label: string;
}> = [
  { id: "form", label: "Form" },
  { id: "yaml", label: "YAML" },
  { id: "toml", label: "TOML" },
];

export function SettingsViewToggle({
  representation,
  onChange,
}: {
  representation: "form" | RawFormat;
  onChange: (next: "form" | RawFormat) => void;
}) {
  return (
    <div
      className="set__view"
      role="radiogroup"
      aria-label="Settings representation"
    >
      {VIEWS.map((view) => (
        <button
          key={view.id}
          type="button"
          className="set__view-btn"
          aria-pressed={representation === view.id}
          onClick={() => onChange(view.id)}
        >
          {view.label}
        </button>
      ))}
    </div>
  );
}
